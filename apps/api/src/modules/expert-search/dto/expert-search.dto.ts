// apps/api/src/modules/expert-search/dto/expert-search.dto.ts

import { Field, Float, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum ExpertSource {
  ACADEMIC = 'ACADEMIC',
  RECRUITMENT = 'RECRUITMENT',
}

export enum RecommendedAction {
  OUTREACH = 'OUTREACH',
  REVIEW = 'REVIEW',
  SKIP = 'SKIP',
}

registerEnumType(ExpertSource, { name: 'ExpertSource' });
registerEnumType(RecommendedAction, { name: 'RecommendedAction' });

// ─── Input ───────────────────────────────────────────────────────────────────

@InputType()
export class ExpertSearchInput {
  @Field()
  @IsString()
  topic: string;

  @Field()
  @IsString()
  jobTitle: string;

  @Field()
  @IsString()
  jobDescription: string;

  @Field(() => [String])
  @IsArray()
  locations: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  seniorities?: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  companyKeywords?: string[];

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  minHIndex?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  minCitations?: number;
}

// ─── Result types ─────────────────────────────────────────────────────────────

@ObjectType()
export class ExpertSearchResultDto {
  @Field()
  id: string;

  @Field(() => ExpertSource)
  source: ExpertSource;

  @Field()
  name: string;

  @Field({ nullable: true })
  email?: string;

  @Field({ nullable: true })
  orcid?: string;

  @Field({ nullable: true })
  openAlexId?: string;

  @Field(() => Int, { nullable: true })
  hIndex?: number;

  @Field(() => Int, { nullable: true })
  citations?: number;

  @Field(() => Int, { nullable: true })
  worksCount?: number;

  @Field({ nullable: true })
  lastInstitution?: string;

  @Field({ nullable: true })
  jobTitle?: string;

  @Field({ nullable: true })
  seniority?: string;

  @Field({ nullable: true })
  company?: string;

  @Field({ nullable: true })
  linkedinUrl?: string;

  @Field(() => Float)
  fitScore: number;

  @Field(() => Float)
  confidence: number;

  @Field(() => RecommendedAction)
  recommendedAction: RecommendedAction;

  @Field()
  scoringRationale: string;

  @Field()
  outreachDraft: string;
}

@ObjectType()
export class ExpertSearchDto {
  @Field()
  id: string;

  @Field()
  status: string;

  @Field({ nullable: true })
  statusDetail?: string;

  @Field()
  topic: string;

  @Field()
  jobTitle: string;

  @Field(() => [ExpertSearchResultDto])
  results: ExpertSearchResultDto[];

  @Field(() => Int, { nullable: true })
  resultCount?: number;

  @Field()
  createdAt: Date;

  @Field({ nullable: true })
  completedAt?: Date;

  @Field({ nullable: true })
  errorMessage?: string;
}
