// apps/api/src/modules/expert-search/services/scoring.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AcademicCandidate } from './openalex.service';
import { RecruitmentCandidate } from './apollo.service';
import { ExpertSource, RecommendedAction } from '../dto/expert-search.dto';

export interface ScoredCandidate {
  // Identity (source-merged)
  source: ExpertSource;
  name: string;
  email?: string;
  orcid?: string;
  openAlexId?: string;
  apolloId?: string;
  // Academic metrics
  hIndex?: number;
  citations?: number;
  worksCount?: number;
  lastInstitution?: string;
  topicPaperCount?: number;
  // Recruitment fields
  jobTitle?: string;
  seniority?: string;
  company?: string;
  linkedinUrl?: string;
  // Scoring output
  fitScore: number;
  confidence: number;
  recommendedAction: RecommendedAction;
  scoringRationale: string;
  outreachDraft: string;
}

interface ScoringContext {
  topic: string;
  jobTitle: string;
  jobDescription: string;
  locations: string[];
}

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);
  private readonly anthropic: Anthropic;
  // Score in batches to stay within rate limits
  private readonly BATCH_SIZE = 5;

  constructor(private readonly config: ConfigService) {
    this.anthropic = new Anthropic({
      apiKey: this.config.getOrThrow('ANTHROPIC_API_KEY'),
    });
  }

  // ─── Public entry point ─────────────────────────────────────────────────────

  async scoreAndMerge(params: {
    academic: AcademicCandidate[];
    recruitment: RecruitmentCandidate[];
    context: ScoringContext;
  }): Promise<ScoredCandidate[]> {
    const { academic, recruitment, context } = params;

    // Build unified candidate list, deduplicating by email or ORCID
    const merged = this.mergeAndDedup(academic, recruitment);
    this.logger.log(`[Scoring] Scoring ${merged.length} unique candidates`);

    // Score in batches
    const scored: ScoredCandidate[] = [];
    for (let i = 0; i < merged.length; i += this.BATCH_SIZE) {
      const batch = merged.slice(i, i + this.BATCH_SIZE);
      const results = await Promise.all(
        batch.map((c) => this.scoreCandidate(c, context)),
      );
      scored.push(...results);
      await this.sleep(1000); // respect Anthropic rate limits
    }

    // Sort by fitScore descending
    return scored.sort((a, b) => b.fitScore - a.fitScore);
  }

  // ─── Merge + dedup ───────────────────────────────────────────────────────────

  private mergeAndDedup(
    academic: AcademicCandidate[],
    recruitment: RecruitmentCandidate[],
  ): Array<{ source: ExpertSource; data: AcademicCandidate | RecruitmentCandidate }> {
    const seen = new Set<string>();
    const merged: Array<{ source: ExpertSource; data: AcademicCandidate | RecruitmentCandidate }> = [];

    // Academic first (as per pipeline design)
    for (const a of academic) {
      const key = a.orcid ?? a.emails[0] ?? a.openAlexId;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push({ source: ExpertSource.ACADEMIC, data: a });
    }

    for (const r of recruitment) {
      // Check if this recruitment candidate already appeared in academic list
      const keyEmail = r.email;
      const keyOrcid = r.orcid;
      if ((keyEmail && seen.has(keyEmail)) || (keyOrcid && seen.has(keyOrcid))) continue;
      if (keyEmail) seen.add(keyEmail);
      if (keyOrcid) seen.add(keyOrcid);
      merged.push({ source: ExpertSource.RECRUITMENT, data: r });
    }

    return merged;
  }

  // ─── Per-candidate Claude scoring ────────────────────────────────────────────

  private async scoreCandidate(
    candidate: { source: ExpertSource; data: AcademicCandidate | RecruitmentCandidate },
    context: ScoringContext,
  ): Promise<ScoredCandidate> {
    const { source, data } = candidate;
    const isAcademic = source === ExpertSource.ACADEMIC;

    const academicData = isAcademic ? (data as AcademicCandidate) : null;
    const recruitmentData = !isAcademic ? (data as RecruitmentCandidate) : null;

    // For recruitment KOLs that were enriched with OpenAlex data
    const enrichedRecruitment = !isAcademic ? (data as RecruitmentCandidate) : null;

    const name = isAcademic ? academicData!.name : recruitmentData!.name;
    const email = isAcademic ? academicData!.emails[0] : recruitmentData!.email;
    const hIndex = isAcademic ? academicData!.hIndex : enrichedRecruitment?.hIndex;
    const citations = isAcademic ? academicData!.citations : enrichedRecruitment?.citations;
    const worksCount = isAcademic ? academicData!.worksCount : enrichedRecruitment?.worksCount;

    const candidateProfile = isAcademic
      ? `
Source: ACADEMIC EXPERT
Name: ${academicData!.name}
ORCID: ${academicData!.orcid ?? 'N/A'}
H-Index: ${academicData!.hIndex}
Total Citations: ${academicData!.citations}
Works Count: ${academicData!.worksCount}
Topic-Relevant Papers: ${academicData!.topicPaperCount}
Last Institution: ${academicData!.lastInstitution ?? 'Unknown'}
Emails found in papers: ${academicData!.emails.length > 0 ? 'Yes' : 'No'}
`
      : `
Source: RECRUITMENT CANDIDATE
Name: ${recruitmentData!.name}
Job Title: ${recruitmentData!.jobTitle ?? 'Unknown'}
Seniority: ${recruitmentData!.seniority ?? 'Unknown'}
Company: ${recruitmentData!.company ?? 'Unknown'}
ORCID found: ${recruitmentData!.orcid ? 'Yes' : 'No'}
H-Index (if KOL): ${recruitmentData!.hIndex ?? 'N/A'}
Citations (if KOL): ${recruitmentData!.citations ?? 'N/A'}
`;

    const prompt = `You are an expert talent evaluator for Knowledge Gate Group (KGG), a token-based expert consultation marketplace.

SEARCH CONTEXT:
Topic: ${context.topic}
Role Sought: ${context.jobTitle}
Description: ${context.jobDescription}
Target Locations: ${context.locations.join(', ')}

CANDIDATE PROFILE:
${candidateProfile}

SCORING INSTRUCTIONS:
Evaluate this candidate's fit for an hours-based expert consultation engagement (not employment).
KGG experts set their own price; this is about topic expertise and reachability.

Return ONLY valid JSON with this exact shape:
{
  "fit_score": <number 0-100>,
  "confidence": <number 0.0-1.0>,
  "recommended_action": <"OUTREACH" | "REVIEW" | "SKIP">,
  "scoring_rationale": "<2-3 sentence explanation referencing source-specific signals>",
  "outreach_draft": "<Professional, human-tone outreach message. Must mention: topic area, hours-based flexible engagement, expert sets own rate. 3-4 sentences max.>"
}

Scoring guidance by source:
- ACADEMIC: Weight h-index (>10 = strong), citation count, topic paper relevance, and institution prestige.
- RECRUITMENT: Weight title/seniority match to job description, company relevance, and any academic credentials if present.
Both sources: penalise if location doesn't match, reward if email is available (OUTREACH > REVIEW).`;

    try {
      const res = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = res.content.find((b) => b.type === 'text')?.text ?? '{}';
      const raw = JSON.parse(this.stripJsonFence(text));

      return {
        source,
        name,
        email,
        orcid: isAcademic ? academicData!.orcid : enrichedRecruitment?.orcid,
        openAlexId: isAcademic ? academicData!.openAlexId : enrichedRecruitment?.openAlexId,
        apolloId: !isAcademic ? recruitmentData!.apolloId : undefined,
        hIndex,
        citations,
        worksCount,
        lastInstitution: isAcademic ? academicData!.lastInstitution : enrichedRecruitment?.lastInstitution,
        topicPaperCount: isAcademic ? academicData!.topicPaperCount : undefined,
        jobTitle: !isAcademic ? recruitmentData!.jobTitle : undefined,
        seniority: !isAcademic ? recruitmentData!.seniority : undefined,
        company: !isAcademic ? recruitmentData!.company : undefined,
        linkedinUrl: !isAcademic ? recruitmentData!.linkedinUrl : undefined,
        fitScore: Math.min(100, Math.max(0, raw.fit_score ?? 0)),
        confidence: Math.min(1, Math.max(0, raw.confidence ?? 0)),
        recommendedAction: this.parseAction(raw.recommended_action),
        scoringRationale: raw.scoring_rationale ?? '',
        outreachDraft: raw.outreach_draft ?? '',
      };
    } catch (err) {
      this.logger.warn(`[Scoring] Claude scoring failed for ${name}: ${err.message}`);
      // Return a minimal record rather than dropping the candidate
      return this.fallbackScore(source, name, email, isAcademic ? academicData! : null, !isAcademic ? recruitmentData! : null);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private parseAction(raw: string): RecommendedAction {
    if (raw === 'OUTREACH') return RecommendedAction.OUTREACH;
    if (raw === 'SKIP') return RecommendedAction.SKIP;
    return RecommendedAction.REVIEW;
  }

  private fallbackScore(
    source: ExpertSource,
    name: string,
    email: string | undefined,
    academic: AcademicCandidate | null,
    recruitment: RecruitmentCandidate | null,
  ): ScoredCandidate {
    return {
      source,
      name,
      email,
      orcid: academic?.orcid ?? recruitment?.orcid,
      openAlexId: academic?.openAlexId ?? recruitment?.openAlexId,
      apolloId: recruitment?.apolloId,
      hIndex: academic?.hIndex ?? recruitment?.hIndex,
      citations: academic?.citations ?? recruitment?.citations,
      worksCount: academic?.worksCount ?? recruitment?.worksCount,
      lastInstitution: academic?.lastInstitution ?? recruitment?.lastInstitution,
      topicPaperCount: academic?.topicPaperCount,
      jobTitle: recruitment?.jobTitle,
      seniority: recruitment?.seniority,
      company: recruitment?.company,
      linkedinUrl: recruitment?.linkedinUrl,
      fitScore: 0,
      confidence: 0,
      recommendedAction: RecommendedAction.REVIEW,
      scoringRationale: 'Scoring failed — manual review required.',
      outreachDraft: '',
    };
  }

  private stripJsonFence(text: string): string {
    return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
