// apps/api/src/modules/expert-search/expert-search.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service'; // adjust path to your PrismaService
import { ExpertSearchInput, ExpertSource, RecommendedAction } from './dto/expert-search.dto';
import { OpenAlexService } from './services/openalex.service';
import { ApolloService } from './services/apollo.service';
import { ScoringService, ScoredCandidate } from './services/scoring.service';
import { NormalisationService } from './services/normalisation.service';
import { ClayService } from './services/clay.service';

@Injectable()
export class ExpertSearchService {
  private readonly logger = new Logger(ExpertSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openAlex: OpenAlexService,
    private readonly apollo: ApolloService,
    private readonly scoring: ScoringService,
    private readonly normalisation: NormalisationService,
    private readonly clay: ClayService,
  ) {}

  // ─── Trigger a new search ────────────────────────────────────────────────────

  async runSearch(input: ExpertSearchInput, triggeredBy: string) {
    // Create the search record immediately so the UI can show "RUNNING" status
    const search = await this.prisma.expertSearch.create({
      data: {
        triggeredBy,
        topic: input.topic,
        jobTitle: input.jobTitle,
        jobDescription: input.jobDescription,
        locations: input.locations,
        seniorities: input.seniorities ?? [],
        companyKeywords: input.companyKeywords ?? [],
        minHIndex: input.minHIndex ?? 0,
        minCitations: input.minCitations ?? 0,
        status: 'RUNNING',
      },
    });

    this.logger.log(`[ExpertSearch] Started search ${search.id} for topic: "${input.topic}"`);

    // Run pipeline async — don't await so the mutation returns immediately
    this.executePipeline(search.id, input).catch(async (err) => {
      this.logger.error(`[ExpertSearch] Pipeline failed for ${search.id}: ${err.message}`, err.stack);
      try {
        await this.prisma.expertSearch.update({
          where: { id: search.id },
          data: { status: 'FAILED', errorMessage: err.message },
        });
      } catch (updateErr) {
        this.logger.error(`[ExpertSearch] Failed to mark search ${search.id} as FAILED: ${updateErr.message}`);
      }
    });

    return search;
  }

  // ─── Status updater ──────────────────────────────────────────────────────────

  private async updateStatus(searchId: string, statusDetail: string) {
    this.logger.log(`[ExpertSearch:${searchId}] ${statusDetail}`);
    try {
      await this.prisma.expertSearch.update({
        where: { id: searchId },
        data: { statusDetail },
      });
    } catch (err) {
      this.logger.warn(`[ExpertSearch:${searchId}] Failed to update statusDetail: ${err.message}`);
    }
  }

  // ─── Full pipeline ───────────────────────────────────────────────────────────

  private async executePipeline(searchId: string, input: ExpertSearchInput) {
    const progress = (detail: string) => this.updateStatus(searchId, detail);

    // ── PHASE 0: Normalise inputs ────────────────────────────────────────────
    await progress('Normalising search inputs…');
    const normalised = await this.normalisation.normalise(input);

    // ── PHASE 1: Academic expert identification (OpenAlex) ───────────────────
    await progress('Searching academic literature…');
    const academicCandidates = await this.openAlex.findAcademicExperts({
      topic: input.topic,
      locations: normalised.locations,
      minHIndex: input.minHIndex ?? 0,
      minCitations: input.minCitations ?? 0,
      onProgress: progress,
    });
    await progress(`Found ${academicCandidates.length} academic candidates`);

    // ── PHASE 2: Recruitment search (Apollo.io) ──────────────────────────────
    let recruitmentCandidates: Awaited<ReturnType<ApolloService['findRecruitmentCandidates']>> = [];
    try {
      await progress('Searching recruitment databases…');
      recruitmentCandidates = await this.apollo.findRecruitmentCandidates({
        normalised,
      });
      await progress(`Found ${recruitmentCandidates.length} recruitment candidates`);
    } catch (err) {
      this.logger.warn(`[ExpertSearch:${searchId}] Apollo phase failed (non-fatal): ${err.message}`);
      await progress('Recruitment search failed — continuing with academic candidates only');
    }

    // ── PHASE 3: Unified scoring + dedup ────────────────────────────────────
    const totalCandidates = academicCandidates.length + recruitmentCandidates.length;
    if (totalCandidates === 0) {
      this.logger.warn(`[ExpertSearch:${searchId}] No candidates from any source — nothing to score`);
      await progress('No candidates found from any source');
      await this.persistResults(searchId, []);
      return;
    }

    await progress(`Scoring ${totalCandidates} candidates with AI…`);
    const scored = await this.scoring.scoreAndMerge({
      academic: academicCandidates,
      recruitment: recruitmentCandidates,
      context: {
        topic: input.topic,
        jobTitle: input.jobTitle,
        jobDescription: input.jobDescription,
        locations: input.locations,
      },
      onProgress: progress,
    });
    await progress(`Scored ${scored.length} candidates`);

    // ── PHASE 3.5: Clay email enrichment (high-relevance, missing email only) ─
    let enriched = scored;
    try {
      await progress('Enriching emails for top candidates…');
      enriched = await this.clay.enrichEmails(scored);
    } catch (err) {
      this.logger.warn(`[ExpertSearch:${searchId}] Clay enrichment failed (non-fatal): ${err.message}`);
      await progress('Email enrichment failed — continuing with available data');
    }

    // ── Persist results ──────────────────────────────────────────────────────
    await progress('Saving results…');
    await this.persistResults(searchId, enriched);

    this.logger.log(`[ExpertSearch:${searchId}] Pipeline complete ✓`);
  }

  // ─── Persist to Postgres ─────────────────────────────────────────────────────

  private async persistResults(searchId: string, candidates: ScoredCandidate[]) {
    this.logger.log(
      `[ExpertSearch:${searchId}] Persisting ${candidates.length} candidates ` +
        `(${candidates.filter((c) => c.email).length} with email, ` +
        `${candidates.filter((c) => c.recommendedAction === 'OUTREACH').length} recommended for outreach)`,
    );

    if (candidates.length === 0) {
      this.logger.warn(`[ExpertSearch:${searchId}] No candidates to persist — pipeline produced 0 results`);
    }

    await this.prisma.$transaction([
      this.prisma.expertSearchResult.createMany({
        data: candidates.map((c) => ({
          searchId,
          source: c.source,
          name: c.name,
          email: c.email,
          orcid: c.orcid,
          openAlexId: c.openAlexId,
          apolloId: c.apolloId,
          hIndex: c.hIndex,
          citations: c.citations,
          worksCount: c.worksCount,
          lastInstitution: c.lastInstitution,
          jobTitle: c.jobTitle,
          seniority: c.seniority,
          company: c.company,
          linkedinUrl: c.linkedinUrl,
          fitScore: c.fitScore,
          confidence: c.confidence,
          recommendedAction: c.recommendedAction,
          scoringRationale: c.scoringRationale,
          outreachDraft: c.outreachDraft,
        })),
      }),
      this.prisma.expertSearch.update({
        where: { id: searchId },
        data: { status: 'COMPLETE', completedAt: new Date() },
      }),
    ]);
  }

  // ─── Query helpers ───────────────────────────────────────────────────────────

  async getSearch(id: string) {
    return this.prisma.expertSearch.findUniqueOrThrow({
      where: { id },
      include: { results: { orderBy: { fitScore: 'desc' } } },
    });
  }

  async listSearches(triggeredBy: string) {
    return this.prisma.expertSearch.findMany({
      where: { triggeredBy },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { results: true } } },
    });
  }
}
