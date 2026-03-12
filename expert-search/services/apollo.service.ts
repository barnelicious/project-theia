// apps/api/src/modules/expert-search/services/apollo.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { OpenAlexService } from './openalex.service';

export interface RecruitmentCandidate {
  apolloId: string;
  name: string;
  firstName: string;
  lastName: string;
  email?: string;
  linkedinUrl?: string;
  jobTitle?: string;
  seniority?: string;
  company?: string;
  // Populated if KOL-flagged and ORCID found
  orcid?: string;
  openAlexId?: string;
  hIndex?: number;
  citations?: number;
  worksCount?: number;
  lastInstitution?: string;
}

interface NormalisedSearchParams {
  jobTitles: string[];
  locations: string[];
  orgKeywordTags: string[];
  seniorities: string[];
}

@Injectable()
export class ApolloService {
  private readonly logger = new Logger(ApolloService.name);
  private readonly client: AxiosInstance;
  private readonly MAX_PAGES = 4;
  private readonly PER_PAGE = 25;

  constructor(
    private readonly config: ConfigService,
    private readonly openAlexService: OpenAlexService,
  ) {
    this.client = axios.create({
      baseURL: 'https://api.apollo.io/api/v1',
      headers: {
        'x-api-key': this.config.getOrThrow('APOLLO_API_KEY'),
        'Content-Type': 'application/json',
      },
    });
  }

  // ─── Public entry point ─────────────────────────────────────────────────────

  async findRecruitmentCandidates(params: {
    normalised: NormalisedSearchParams;
  }): Promise<RecruitmentCandidate[]> {
    const { normalised } = params;

    this.logger.log(`[Apollo] Starting people search: titles=${JSON.stringify(normalised.jobTitles)}`);

    // Step 1: Paginated people search
    const raw = await this.paginatedPeopleSearch(normalised);
    this.logger.log(`[Apollo] Retrieved ${raw.length} raw candidates`);

    // Step 2: Deduplicate by LinkedIn URL or name+company
    const deduped = this.deduplicate(raw);
    this.logger.log(`[Apollo] ${deduped.length} after deduplication`);

    // Step 3: Enrich emails via Apollo /people/match
    const enriched = await this.enrichEmails(deduped);

    // Step 4: ORCID lookup for KOL candidates → OpenAlex enrichment
    const withAcademicData = await this.enrichKolCandidates(enriched);

    return withAcademicData;
  }

  // ─── Step 1: Paginated search ────────────────────────────────────────────────

  private async paginatedPeopleSearch(params: NormalisedSearchParams): Promise<any[]> {
    const allResults: any[] = [];

    for (let page = 1; page <= this.MAX_PAGES; page++) {
      try {
        const body: Record<string, any> = {
          page,
          per_page: this.PER_PAGE,
          person_titles: params.jobTitles,
        };

        if (params.locations.length) body.person_locations = params.locations;
        if (params.orgKeywordTags.length) body.q_organization_keyword_tags = params.orgKeywordTags;
        if (params.seniorities.length) body.person_seniorities = params.seniorities;

        const res = await this.client.post('/mixed_people/search', body);
        const people = res.data.people ?? [];

        allResults.push(...people);

        const totalPages = res.data.pagination?.total_pages ?? 1;
        if (page >= totalPages) break;

        await this.sleep(300);
      } catch (err) {
        this.logger.warn(`[Apollo] People search page ${page} failed: ${err.message}`);
        break;
      }
    }

    return allResults;
  }

  // ─── Step 2: Deduplication ───────────────────────────────────────────────────

  private deduplicate(people: any[]): any[] {
    const seen = new Set<string>();
    return people.filter((p) => {
      const key = p.linkedin_url ?? `${p.first_name}|${p.last_name}|${p.organization?.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ─── Step 3: Email enrichment ────────────────────────────────────────────────

  private async enrichEmails(people: any[]): Promise<any[]> {
    const results: any[] = [];

    for (const person of people) {
      // Skip if Apollo already provided an email
      if (person.email) {
        results.push(person);
        continue;
      }

      try {
        const res = await this.client.post('/people/match', {
          first_name: person.first_name,
          last_name: person.last_name,
          organization_name: person.organization?.name,
          linkedin_url: person.linkedin_url,
          reveal_personal_emails: false,
        });
        results.push({ ...person, email: res.data.person?.email });
        await this.sleep(200);
      } catch {
        results.push(person);
      }
    }

    return results;
  }

  // ─── Step 4: KOL → ORCID → OpenAlex ─────────────────────────────────────────
  // A "KOL" (Key Opinion Leader) is flagged by Apollo with `is_likely_to_engage`
  // or by having academic-sounding titles. We then look them up on ORCID.

  private async enrichKolCandidates(people: any[]): Promise<RecruitmentCandidate[]> {
    const candidates: RecruitmentCandidate[] = [];

    for (const p of people) {
      const isKol = p.is_likely_to_engage || this.hasAcademicTitle(p.title);

      const base: RecruitmentCandidate = {
        apolloId: p.id,
        name: `${p.first_name} ${p.last_name}`.trim(),
        firstName: p.first_name,
        lastName: p.last_name,
        email: p.email,
        linkedinUrl: p.linkedin_url,
        jobTitle: p.title,
        seniority: p.seniority,
        company: p.organization?.name,
      };

      if (isKol) {
        const orcid = await this.lookupOrcid(p.first_name, p.last_name, p.organization?.name);
        if (orcid) {
          const academic = await this.openAlexService.enrichByOrcid(orcid);
          Object.assign(base, { orcid, ...academic });
        }
      }

      candidates.push(base);
    }

    return candidates;
  }

  // ─── ORCID public API lookup ─────────────────────────────────────────────────

  private async lookupOrcid(
    firstName: string,
    lastName: string,
    affiliation?: string,
  ): Promise<string | null> {
    try {
      const q = [
        `given-names:${firstName}`,
        `family-name:${lastName}`,
        affiliation ? `affiliation-org-name:${encodeURIComponent(affiliation)}` : '',
      ]
        .filter(Boolean)
        .join(' AND ');

      const res = await axios.get(`https://pub.orcid.org/v3.0/expanded-search/?q=${q}`, {
        headers: { Accept: 'application/json' },
        timeout: 8000,
      });

      const results = res.data['expanded-result'] ?? [];
      if (!results.length) return null;

      // Score matches: prefer exact name matches
      const best = results
        .map((r: any) => ({
          orcid: r['orcid-id'],
          score: this.nameMatchScore(firstName, lastName, r['given-names'], r['family-names']),
        }))
        .filter((r: any) => r.score > 0.7)
        .sort((a: any, b: any) => b.score - a.score)[0];

      return best?.orcid ?? null;
    } catch {
      return null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private hasAcademicTitle(title?: string): boolean {
    if (!title) return false;
    const academic = ['professor', 'phd', 'researcher', 'scientist', 'director', 'principal investigator', 'fellow'];
    return academic.some((t) => title.toLowerCase().includes(t));
  }

  private nameMatchScore(
    firstName: string,
    lastName: string,
    givenNames: string[],
    familyNames: string[],
  ): number {
    const given = (givenNames ?? []).join(' ').toLowerCase();
    const family = (familyNames ?? []).join(' ').toLowerCase();
    const firstMatch = given.includes(firstName.toLowerCase()) ? 1 : 0;
    const lastMatch = family.includes(lastName.toLowerCase()) ? 1 : 0;
    return (firstMatch + lastMatch) / 2;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
