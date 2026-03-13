// apps/api/src/modules/expert-search/expert-search.resolver.ts

import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ForbiddenException, UseGuards } from '@nestjs/common';
// Adjust these imports to match your existing auth setup
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { ExpertSearchService } from './expert-search.service';
import { ExpertSearchDto, ExpertSearchInput } from './dto/expert-search.dto';

@Resolver(() => ExpertSearchDto)
// @UseGuards(GqlAuthGuard) // TODO: Re-enable when auth is wired up
export class ExpertSearchResolver {
  constructor(private readonly expertSearchService: ExpertSearchService) {}

  /**
   * Triggers a new expert search pipeline.
   * Returns immediately with status RUNNING — poll getExpertSearch for results.
   */
  @Mutation(() => ExpertSearchDto)
  async runExpertSearch(
    @Args('input') input: ExpertSearchInput,
    // @CurrentUser() user: { id: string }, // TODO: Re-enable when auth is wired up
  ): Promise<ExpertSearchDto> {
    const userId = 'dev-user'; // TODO: Replace with user.id when auth is wired up
    const search = await this.expertSearchService.runSearch(input, userId);
    return {
      id: search.id,
      status: search.status,
      statusDetail: search.statusDetail ?? undefined,
      topic: search.topic,
      jobTitle: search.jobTitle,
      results: [],
      createdAt: search.createdAt,
    };
  }

  /**
   * Fetch a specific search by ID, including all scored results.
   * Results are ordered by fitScore descending.
   */
  @Query(() => ExpertSearchDto)
  async getExpertSearch(
    @Args('id') id: string,
    // @CurrentUser() user: { id: string }, // TODO: Re-enable when auth is wired up
  ): Promise<ExpertSearchDto> {
    const search = await this.expertSearchService.getSearch(id);
    return {
      id: search.id,
      status: search.status,
      statusDetail: search.statusDetail ?? undefined,
      topic: search.topic,
      jobTitle: search.jobTitle,
      results: search.results.map((r) => ({
        id: r.id,
        source: r.source as any,
        name: r.name,
        email: r.email ?? undefined,
        orcid: r.orcid ?? undefined,
        openAlexId: r.openAlexId ?? undefined,
        hIndex: r.hIndex ?? undefined,
        citations: r.citations ?? undefined,
        worksCount: r.worksCount ?? undefined,
        lastInstitution: r.lastInstitution ?? undefined,
        jobTitle: r.jobTitle ?? undefined,
        seniority: r.seniority ?? undefined,
        company: r.company ?? undefined,
        linkedinUrl: r.linkedinUrl ?? undefined,
        fitScore: r.fitScore,
        confidence: r.confidence,
        recommendedAction: r.recommendedAction as any,
        scoringRationale: r.scoringRationale,
        outreachDraft: r.outreachDraft,
      })),
      createdAt: search.createdAt,
      completedAt: search.completedAt ?? undefined,
      errorMessage: search.errorMessage ?? undefined,
    };
  }

  /**
   * List all searches triggered by the current user.
   */
  @Query(() => [ExpertSearchDto])
  async listExpertSearches(
    // @CurrentUser() user: { id: string }, // TODO: Re-enable when auth is wired up
  ): Promise<ExpertSearchDto[]> {
    const userId = 'dev-user'; // TODO: Replace with user.id when auth is wired up
    const searches = await this.expertSearchService.listSearches(userId);
    return searches.map((s: any) => ({
      id: s.id,
      status: s.status,
      statusDetail: s.statusDetail ?? undefined,
      topic: s.topic,
      jobTitle: s.jobTitle,
      results: [],
      resultCount: s._count?.results ?? 0,
      createdAt: s.createdAt,
      completedAt: s.completedAt ?? undefined,
    }));
  }
}
