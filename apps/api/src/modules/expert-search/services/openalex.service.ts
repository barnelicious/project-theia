// apps/api/src/modules/expert-search/services/openalex.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface OpenAlexAuthorRaw {
  id: string;
  display_name: string;
  orcid?: string;
  works_count: number;
  cited_by_count: number;
  summary_stats: { h_index: number };
  last_known_institutions: Array<{ display_name: string; country_code: string }>;
}

export interface AcademicCandidate {
  openAlexId: string;
  name: string;
  orcid?: string;
  hIndex: number;
  citations: number;
  worksCount: number;
  lastInstitution?: string;
  emails: string[];
  topicPaperCount: number;
}

// Common location name → ISO 3166-1 alpha-2 country code mapping
const LOCATION_TO_COUNTRY_CODE: Record<string, string> = {
  'united states': 'us', 'usa': 'us', 'us': 'us',
  'united kingdom': 'gb', 'uk': 'gb', 'gb': 'gb', 'england': 'gb', 'scotland': 'gb', 'wales': 'gb',
  'canada': 'ca', 'ca': 'ca',
  'australia': 'au', 'au': 'au',
  'germany': 'de', 'de': 'de',
  'france': 'fr', 'fr': 'fr',
  'netherlands': 'nl', 'nl': 'nl',
  'switzerland': 'ch', 'ch': 'ch',
  'japan': 'jp', 'jp': 'jp',
  'china': 'cn', 'cn': 'cn',
  'india': 'in', 'in': 'in',
  'brazil': 'br', 'br': 'br',
  'italy': 'it', 'it': 'it',
  'spain': 'es', 'es': 'es',
  'south korea': 'kr', 'korea': 'kr', 'kr': 'kr',
  'sweden': 'se', 'se': 'se',
  'israel': 'il', 'il': 'il',
  'singapore': 'sg', 'sg': 'sg',
  'new zealand': 'nz', 'nz': 'nz',
  'ireland': 'ie', 'ie': 'ie',
  'belgium': 'be', 'be': 'be',
  'austria': 'at', 'at': 'at',
  'denmark': 'dk', 'dk': 'dk',
  'norway': 'no', 'no': 'no',
  'finland': 'fi', 'fi': 'fi',
  'portugal': 'pt', 'pt': 'pt',
  'poland': 'pl', 'pl': 'pl',
};

@Injectable()
export class OpenAlexService {
  private readonly logger = new Logger(OpenAlexService.name);
  private readonly client: AxiosInstance;
  private readonly RATE_LIMIT_MS = 1100; // OpenAlex polite pool: ~1 req/sec

  constructor(private readonly config: ConfigService) {
    this.client = axios.create({
      baseURL: 'https://api.openalex.org',
      headers: {
        // OpenAlex polite pool — identify yourself
        'User-Agent': `IRIS/1.0 (mailto:${this.config.get('OPENALEX_EMAIL', 'info@knowledgegategroup.com')})`,
      },
    });
  }

  // ─── Public entry point ─────────────────────────────────────────────────────

  async findAcademicExperts(params: {
    topic: string;
    locations: string[];
    minHIndex: number;
    minCitations: number;
    maxResults?: number;
  }): Promise<AcademicCandidate[]> {
    const { topic, locations, minHIndex, minCitations, maxResults = 300 } = params;

    this.logger.log(`[OpenAlex] Starting academic search: topic="${topic}", locations=${JSON.stringify(locations)}`);

    // Step 1: Search works by topic, collect unique author IDs with topic paper counts
    const authorPaperCounts = await this.searchAuthorsByTopic(topic, maxResults);
    this.logger.log(`[OpenAlex] Found ${authorPaperCounts.size} unique authors from topic search`);

    // Step 2: Enrich each author, apply threshold filter
    const enriched = await this.enrichAuthors(authorPaperCounts, { minHIndex, minCitations, locations });
    this.logger.log(`[OpenAlex] ${enriched.length} authors passed thresholds`);

    // Step 3: For qualifying authors, attempt email extraction from recent PDFs
    const withEmails = await this.extractEmailsFromPapers(enriched);

    return withEmails;
  }

  // ─── Step 1: Topic → Author IDs ─────────────────────────────────────────────

  private async searchAuthorsByTopic(topic: string, maxResults: number): Promise<Map<string, number>> {
    const authorPaperCounts = new Map<string, number>();
    let cursor = '*';
    let fetched = 0;
    const perPage = 50;
    const maxPages = Math.ceil(maxResults / perPage);

    for (let page = 0; page < maxPages; page++) {
      try {
        const res = await this.client.get('/works', {
          params: {
            search: topic,
            'per-page': perPage,
            cursor,
            filter: 'publication_year:>2019',
            select: 'authorships',
          },
        });

        const works = res.data.results ?? [];
        if (!works.length) break;

        for (const work of works) {
          for (const authorship of work.authorships ?? []) {
            const id = authorship.author?.id;
            if (id) {
              const shortId = id.replace('https://openalex.org/', '');
              authorPaperCounts.set(shortId, (authorPaperCounts.get(shortId) ?? 0) + 1);
            }
          }
        }

        cursor = res.data.meta?.next_cursor;
        fetched += works.length;
        if (!cursor || fetched >= maxResults) break;

        await this.sleep(this.RATE_LIMIT_MS);
      } catch (err) {
        this.logger.warn(`[OpenAlex] Topic search page ${page} failed: ${err.message}`);
        break;
      }
    }

    return authorPaperCounts;
  }

  // ─── Step 2: Enrich authors + filter ────────────────────────────────────────

  private async enrichAuthors(
    authorPaperCounts: Map<string, number>,
    filters: { minHIndex: number; minCitations: number; locations: string[] },
  ): Promise<(OpenAlexAuthorRaw & { topicPaperCount: number })[]> {
    const results: (OpenAlexAuthorRaw & { topicPaperCount: number })[] = [];

    for (const [id, topicPaperCount] of authorPaperCounts) {
      try {
        const res = await this.client.get(`/authors/${id}`);
        const author: OpenAlexAuthorRaw = res.data;

        const hIndex = author.summary_stats?.h_index ?? 0;
        const citations = author.cited_by_count ?? 0;

        if (hIndex < filters.minHIndex || citations < filters.minCitations) {
          await this.sleep(this.RATE_LIMIT_MS);
          continue;
        }

        // Location filter — skip if locations specified and author doesn't match
        if (filters.locations.length > 0) {
          const authorCountry = author.last_known_institutions?.[0]?.country_code?.toLowerCase() ?? '';
          const allowedCodes = filters.locations
            .map((loc) => LOCATION_TO_COUNTRY_CODE[loc.toLowerCase().trim()])
            .filter(Boolean);
          if (allowedCodes.length > 0 && !allowedCodes.includes(authorCountry)) {
            await this.sleep(this.RATE_LIMIT_MS);
            continue;
          }
        }

        results.push({ ...author, topicPaperCount });
        await this.sleep(this.RATE_LIMIT_MS);
      } catch (err) {
        this.logger.warn(`[OpenAlex] Author enrichment failed for ${id}: ${err.message}`);
        await this.sleep(this.RATE_LIMIT_MS);
      }
    }

    return results;
  }

  // ─── Step 3: PDF email extraction ───────────────────────────────────────────

  private async extractEmailsFromPapers(
    authors: (OpenAlexAuthorRaw & { topicPaperCount: number })[],
  ): Promise<AcademicCandidate[]> {
    const candidates: AcademicCandidate[] = [];

    for (const author of authors) {
      const authorId = author.id.replace('https://openalex.org/', '');
      let emails: string[] = [];

      try {
        // Fetch recent papers with PDF URLs
        const worksRes = await this.client.get('/works', {
          params: {
            filter: `authorships.author.id:openalex:${authorId},publication_year:>2019`,
            'per-page': 20,
            select: 'primary_location,locations',
          },
        });

        const works = worksRes.data.results ?? [];
        const pdfUrls = this.extractPdfUrls(works);

        for (const url of pdfUrls.slice(0, 5)) { // max 5 PDFs per author
          const extracted = await this.extractEmailsFromPdf(url);
          emails.push(...extracted);
          await this.sleep(500);
        }

        emails = [...new Set(emails)].filter((e) => !e.includes('example.com'));
        await this.sleep(this.RATE_LIMIT_MS);
      } catch (err) {
        this.logger.warn(`[OpenAlex] PDF extraction failed for ${author.display_name}: ${err.message}`);
      }

      candidates.push({
        openAlexId: author.id,
        name: author.display_name,
        orcid: author.orcid,
        hIndex: author.summary_stats?.h_index ?? 0,
        citations: author.cited_by_count ?? 0,
        worksCount: author.works_count ?? 0,
        lastInstitution: author.last_known_institutions?.[0]?.display_name,
        emails,
        topicPaperCount: author.topicPaperCount,
      });
    }

    return candidates;
  }

  // ─── ORCID → OpenAlex lookup (used by ApolloService for KOL enrichment) ────

  async enrichByOrcid(orcid: string): Promise<Partial<AcademicCandidate> | null> {
    try {
      const res = await this.client.get('/authors', {
        params: { filter: `orcid:${orcid}` },
      });
      const author: OpenAlexAuthorRaw = res.data.results?.[0];
      if (!author) return null;

      return {
        openAlexId: author.id,
        hIndex: author.summary_stats?.h_index ?? 0,
        citations: author.cited_by_count ?? 0,
        worksCount: author.works_count ?? 0,
        lastInstitution: author.last_known_institutions?.[0]?.display_name,
      };
    } catch {
      return null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private extractPdfUrls(works: any[]): string[] {
    const urls: string[] = [];
    for (const work of works) {
      const fromPrimary = work.primary_location?.pdf_url;
      if (fromPrimary) { urls.push(fromPrimary); continue; }
      const fromLocations = (work.locations ?? []).find((l: any) => l.pdf_url)?.pdf_url;
      if (fromLocations) urls.push(fromLocations);
    }
    return urls;
  }

  private async extractEmailsFromPdf(url: string): Promise<string[]> {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'IRIS/1.0' },
      });

      // Use pdf-parse (must be installed: pnpm --filter api add pdf-parse)
      const pdfParse = await import('pdf-parse');
      const data = await pdfParse.default(Buffer.from(res.data));
      const matches = data.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
      return [...new Set(matches)];
    } catch {
      return [];
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
