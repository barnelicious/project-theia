// apps/api/src/modules/expert-search/services/clay.service.ts
//
// Phase 3.5 — Email enrichment via Clay.
//
// Runs AFTER unified scoring, targeting only candidates who:
//   1. Have fitScore >= CLAY_SCORE_THRESHOLD (default 60)
//   2. Have recommendedAction !== SKIP
//   3. Are still missing an email address
//
// Clay's async pattern:
//   find-and-enrich-list-of-contacts  →  taskId
//   add-contact-data-points (Email)   →  enrichment kicks off
//   poll get-existing-search          →  until all completed

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ScoredCandidate } from './scoring.service';
import { RecommendedAction } from '../dto/expert-search.dto';

// Shape Clay returns per contact
interface ClayContact {
  entityId: string;
  contactName: string;
  companyIdentifier: string;
  enrichments?: {
    Email?: { state: 'in-progress' | 'completed'; value?: string };
  };
}

interface ClaySearchResult {
  taskId: string;
  contacts: ClayContact[];
}

@Injectable()
export class ClayService {
  private readonly logger = new Logger(ClayService.name);
  private readonly client: AxiosInstance;

  // Only enrich candidates at or above this fit score threshold
  private readonly CLAY_SCORE_THRESHOLD: number;
  // How long to wait between polls (ms)
  private readonly POLL_INTERVAL_MS = 5000;
  // Max number of poll attempts before giving up
  private readonly MAX_POLL_ATTEMPTS = 12; // 12 × 5s = 60s timeout

  constructor(private readonly config: ConfigService) {
    this.client = axios.create({
      baseURL: this.config.getOrThrow('CLAY_API_BASE_URL'),
      headers: {
        Authorization: `Bearer ${this.config.getOrThrow('CLAY_API_KEY')}`,
        'Content-Type': 'application/json',
      },
    });
    this.CLAY_SCORE_THRESHOLD = parseInt(
      this.config.get('CLAY_SCORE_THRESHOLD', '60'),
      10,
    );
  }

  // ─── Public entry point ─────────────────────────────────────────────────────

  /**
   * Takes the full scored candidate list, filters to high-relevance/missing-email
   * candidates, enriches emails via Clay, and returns the updated list with
   * Clay-sourced emails filled in where found.
   */
  async enrichEmails(candidates: ScoredCandidate[]): Promise<ScoredCandidate[]> {
    const targets = candidates.filter(
      (c) =>
        !c.email &&
        c.fitScore >= this.CLAY_SCORE_THRESHOLD &&
        c.recommendedAction !== RecommendedAction.SKIP,
    );

    if (targets.length === 0) {
      this.logger.log('[Clay] No candidates require email enrichment');
      return candidates;
    }

    this.logger.log(
      `[Clay] Enriching emails for ${targets.length} high-relevance candidates ` +
        `(fitScore ≥ ${this.CLAY_SCORE_THRESHOLD}, action ≠ SKIP, no email yet)`,
    );

    // Step 1: Submit contacts to Clay
    const { taskId, contacts } = await this.submitContacts(targets);
    if (!taskId) {
      this.logger.warn('[Clay] Failed to create Clay search — skipping enrichment');
      return candidates;
    }

    // Step 2: Trigger email enrichment on the task
    await this.requestEmailEnrichment(taskId);

    // Step 3: Poll until complete or timeout
    const enriched = await this.pollUntilComplete(taskId);

    // Step 4: Merge Clay emails back into the candidate list
    return this.mergeEmails(candidates, targets, contacts, enriched);
  }

  // ─── Step 1: Submit contacts ─────────────────────────────────────────────────

  private async submitContacts(
    targets: ScoredCandidate[],
  ): Promise<{ taskId: string; contacts: ClayContact[] }> {
    // Clay requires a company identifier (domain or LinkedIn URL) per contact.
    // For academic candidates, we use their last institution as a search hint.
    // For recruitment candidates, we use their company name converted to a domain guess.
    const contactIdentifiers = targets.map((c) => ({
      contactName: c.name,
      companyIdentifier: this.resolveCompanyIdentifier(c),
    }));

    try {
      const res = await this.client.post('/find-and-enrich-list-of-contacts', {
        contactIdentifiers,
      });

      return {
        taskId: res.data.taskId,
        contacts: res.data.contacts ?? [],
      };
    } catch (err) {
      this.logger.error(`[Clay] Contact submission failed: ${err.message}`);
      return { taskId: '', contacts: [] };
    }
  }

  // ─── Step 2: Request email enrichment ────────────────────────────────────────

  private async requestEmailEnrichment(taskId: string): Promise<void> {
    try {
      await this.client.post('/add-contact-data-points', {
        taskId,
        dataPoints: [{ type: 'Email' }],
      });
      this.logger.log(`[Clay] Email enrichment triggered for task ${taskId}`);
    } catch (err) {
      this.logger.warn(`[Clay] Email enrichment request failed: ${err.message}`);
    }
  }

  // ─── Step 3: Poll until all enrichments are complete ─────────────────────────

  private async pollUntilComplete(taskId: string): Promise<ClayContact[]> {
    for (let attempt = 1; attempt <= this.MAX_POLL_ATTEMPTS; attempt++) {
      await this.sleep(this.POLL_INTERVAL_MS);

      try {
        const res = await this.client.get(`/get-existing-search/${taskId}`);
        const contacts: ClayContact[] = res.data.contacts ?? [];

        const inProgress = contacts.filter(
          (c) => c.enrichments?.Email?.state === 'in-progress',
        );

        this.logger.log(
          `[Clay] Poll ${attempt}/${this.MAX_POLL_ATTEMPTS}: ` +
            `${contacts.length - inProgress.length}/${contacts.length} complete`,
        );

        if (inProgress.length === 0) {
          this.logger.log('[Clay] All enrichments complete ✓');
          return contacts;
        }
      } catch (err) {
        this.logger.warn(`[Clay] Poll attempt ${attempt} failed: ${err.message}`);
      }
    }

    this.logger.warn('[Clay] Polling timed out — returning partial results');
    // Return whatever we have rather than throwing
    try {
      const res = await this.client.get(`/get-existing-search/${taskId}`);
      return res.data.contacts ?? [];
    } catch {
      return [];
    }
  }

  // ─── Step 4: Merge Clay emails back into candidate list ───────────────────────

  private mergeEmails(
    allCandidates: ScoredCandidate[],
    targets: ScoredCandidate[],
    submittedContacts: ClayContact[],
    enrichedContacts: ClayContact[],
  ): ScoredCandidate[] {
    // Build a map: normalised name → Clay email
    const emailMap = new Map<string, string>();
    for (const contact of enrichedContacts) {
      const email = contact.enrichments?.Email?.value;
      if (email) {
        emailMap.set(this.normaliseName(contact.contactName), email);
      }
    }

    let enrichedCount = 0;
    const result = allCandidates.map((candidate) => {
      // Only update candidates that were in our target set and still lack an email
      if (candidate.email) return candidate;
      const isTarget = targets.some((t) => t.name === candidate.name);
      if (!isTarget) return candidate;

      const clayEmail = emailMap.get(this.normaliseName(candidate.name));
      if (clayEmail) {
        enrichedCount++;
        return { ...candidate, email: clayEmail };
      }
      return candidate;
    });

    this.logger.log(`[Clay] Filled ${enrichedCount} email addresses from Clay`);
    return result;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Best-effort company identifier for Clay.
   * Recruitment candidates have a company name; academic candidates have an institution.
   * Clay accepts company names directly if we can't derive a domain.
   */
  private resolveCompanyIdentifier(candidate: ScoredCandidate): string {
    // Prefer LinkedIn URL — most reliable for Clay
    if (candidate.linkedinUrl) {
      // Extract company from linkedin.com/in/name → not useful; skip personal URLs
      // LinkedIn company URLs (linkedin.com/company/...) are useful
      if (candidate.linkedinUrl.includes('/company/')) return candidate.linkedinUrl;
    }

    // Use company name for recruitment candidates
    if (candidate.company) {
      return this.companyNameToDomain(candidate.company);
    }

    // For academic candidates, use last institution
    if (candidate.lastInstitution) {
      return this.companyNameToDomain(candidate.lastInstitution);
    }

    // Last resort — use the candidate's name and hope Clay can infer
    return candidate.name;
  }

  /**
   * Naive company name → domain heuristic.
   * e.g. "Harvard University" → "harvard.edu"
   *      "Johns Hopkins" → "jhu.edu" (not perfect, but Clay handles fuzzy matching)
   */
  private companyNameToDomain(name: string): string {
    const lower = name.toLowerCase().trim();

    // Academic institutions
    if (lower.includes('university') || lower.includes('college') || lower.includes('institute')) {
      // Strip common suffixes and use .edu
      const slug = lower
        .replace(/\b(university|college|institute|of|the|and)\b/g, '')
        .replace(/\s+/g, '')
        .replace(/[^a-z0-9]/g, '');
      return `${slug}.edu`;
    }

    // General companies — strip Inc/Ltd/Corp and convert to domain-like slug
    const slug = lower
      .replace(/\b(inc|ltd|llc|corp|corporation|limited|group)\b\.?/g, '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9]/g, '');

    return `${slug}.com`;
  }

  private normaliseName(name: string): string {
    return name.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
