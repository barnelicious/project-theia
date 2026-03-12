// apps/api/src/modules/expert-search/services/normalisation.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ExpertSearchInput } from '../dto/expert-search.dto';

export interface NormalisedSearchParams {
  jobTitles: string[];
  locations: string[];
  orgKeywordTags: string[];
  seniorities: string[];
}

@Injectable()
export class NormalisationService {
  private readonly logger = new Logger(NormalisationService.name);
  private readonly anthropic: Anthropic;

  constructor(private readonly config: ConfigService) {
    this.anthropic = new Anthropic({
      apiKey: this.config.getOrThrow('ANTHROPIC_API_KEY'),
    });
  }

  async normalise(input: ExpertSearchInput): Promise<NormalisedSearchParams> {
    this.logger.log(`[Normalisation] Normalising inputs for: ${input.jobTitle}`);

    const prompt = `You are an expert in talent search optimisation.

Given the following job search inputs, return a JSON object with normalised values ready for Apollo.io people search API.

INPUTS:
Job Title: ${input.jobTitle}
Job Description: ${input.jobDescription}
Locations: ${input.locations.join(', ')}
Seniorities: ${(input.seniorities ?? []).join(', ')}
Company Keywords: ${(input.companyKeywords ?? []).join(', ')}

Return ONLY valid JSON with no preamble or markdown:
{
  "job_titles": ["<title variant 1>", "<title variant 2>", ...],
  "locations": ["<normalised country/city in lowercase>", ...],
  "org_keyword_tags": ["<company keyword 1>", ...],
  "seniorities": ["<apollo seniority level>", ...]
}

Rules:
- job_titles: Generate 3-6 realistic variants of the job title for search (e.g. "Chief Medical Officer" → ["chief medical officer", "cmo", "medical director"])
- locations: Lowercase, Apollo-compatible country/city names (e.g. "US" → "united states")
- seniorities: Use Apollo levels: senior, director, vp, c_suite, owner, founder, partner
- org_keyword_tags: Clean comma-separated company keyword tags, lowercase, max 5
- If a field has no input, return an empty array`;

    try {
      const res = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = res.content.find((b) => b.type === 'text')?.text ?? '{}';
      const raw = JSON.parse(this.stripJsonFence(text));

      return {
        jobTitles: raw.job_titles ?? [input.jobTitle.toLowerCase()],
        locations: raw.locations ?? input.locations.map((l) => l.toLowerCase()),
        orgKeywordTags: raw.org_keyword_tags ?? [],
        seniorities: raw.seniorities ?? [],
      };
    } catch (err) {
      this.logger.warn(`[Normalisation] Claude normalisation failed, using raw inputs: ${err.message}`);
      // Graceful fallback — use raw inputs as-is
      return {
        jobTitles: [input.jobTitle.toLowerCase()],
        locations: input.locations.map((l) => l.toLowerCase()),
        orgKeywordTags: input.companyKeywords?.map((k) => k.toLowerCase()) ?? [],
        seniorities: input.seniorities?.map((s) => s.toLowerCase()) ?? [],
      };
    }
  }

  private stripJsonFence(text: string): string {
    return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }
}
