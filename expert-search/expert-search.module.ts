// apps/api/src/modules/expert-search/expert-search.module.ts

import { Module } from '@nestjs/common';
import { ExpertSearchResolver } from './expert-search.resolver';
import { ExpertSearchService } from './expert-search.service';
import { OpenAlexService } from './services/openalex.service';
import { ApolloService } from './services/apollo.service';
import { ScoringService } from './services/scoring.service';
import { NormalisationService } from './services/normalisation.service';
import { ClayService } from './services/clay.service';

@Module({
  providers: [
    ExpertSearchResolver,
    ExpertSearchService,
    OpenAlexService,
    ApolloService,
    ScoringService,
    NormalisationService,
    ClayService,
  ],
  exports: [ExpertSearchService],
})
export class ExpertSearchModule {}
