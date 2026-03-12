# Expert Search Module — Integration Guide
## `apps/api/src/modules/expert-search/`

---

## 1. Install dependencies

```bash
pnpm --filter api add pdf-parse @anthropic-ai/sdk axios
pnpm --filter api add -D @types/pdf-parse
```

---

## 2. Add Prisma schema

Copy the contents of `prisma.schema.additions.prisma` into your existing
`apps/api/prisma/schema.prisma`, then run:

```bash
pnpm --filter api prisma:migrate --name add_expert_search
pnpm --filter api prisma:generate
```

---

## 3. Register the module

In `apps/api/src/app.module.ts`, add:

```ts
import { ExpertSearchModule } from './modules/expert-search/expert-search.module';

@Module({
  imports: [
    // ... your existing modules
    ExpertSearchModule,
  ],
})
export class AppModule {}
```

---

## 4. Environment variables

Add to your SSM Parameter Store under `/staging/iris/` and `/production/iris/`:

| Key | Description |
|---|---|
| `APOLLO_API_KEY` | Apollo.io API key (x-api-key header) |
| `ANTHROPIC_API_KEY` | Anthropic API key (Claude for normalisation + scoring) |
| `OPENALEX_EMAIL` | Your email for OpenAlex polite pool (e.g. info@knowledgegategroup.com) |
| `CLAY_API_KEY` | Clay API key (Bearer token) |
| `CLAY_API_BASE_URL` | Clay API base URL (from your Clay workspace settings) |
| `CLAY_SCORE_THRESHOLD` | Optional. Min fitScore (0–100) to trigger Clay enrichment. Default: `60` |

These are pulled automatically by `generate-local-env.sh` once added to SSM.

---

## 5. Auth guard wiring

The resolver uses `@UseGuards(GqlAuthGuard)` and `@CurrentUser()`.
Adjust the import paths in `expert-search.resolver.ts` to match your existing
auth decorator/guard locations.

---

## 6. GraphQL operations

### Trigger a search (returns immediately, pipeline runs async)
```graphql
mutation RunExpertSearch($input: ExpertSearchInput!) {
  runExpertSearch(input: $input) {
    id
    status
    createdAt
  }
}
```

### Poll for results (call every 10–15s until status === "COMPLETE")
```graphql
query GetExpertSearch($id: ID!) {
  getExpertSearch(id: $id) {
    id
    status
    completedAt
    errorMessage
    results {
      id
      source          # ACADEMIC | RECRUITMENT — clearly labelled
      name
      email
      orcid
      hIndex
      citations
      jobTitle
      company
      fitScore        # 0–100 unified score
      confidence
      recommendedAction  # OUTREACH | REVIEW | SKIP
      scoringRationale
      outreachDraft
    }
  }
}
```

### List past searches
```graphql
query ListExpertSearches {
  listExpertSearches {
    id
    topic
    jobTitle
    status
    createdAt
  }
}
```

---

## 7. Future: automatic trigger from client input

The `runExpertSearch` mutation accepts a `triggeredBy` userId. When you're
ready to automate from client topic inputs, you can call
`ExpertSearchService.runSearch(input, clientUserId)` directly from whatever
service handles the client intake — no changes to the module needed.

---

## 8. File structure

```
apps/api/src/modules/expert-search/
├── dto/
│   └── expert-search.dto.ts          # GraphQL types + enums
├── services/
│   ├── openalex.service.ts           # Phase 1 — academic search
│   ├── apollo.service.ts             # Phase 2 — recruitment search
│   ├── scoring.service.ts            # Phase 3 — unified Claude scoring
│   ├── clay.service.ts               # Phase 3.5 — email enrichment (high-relevance only)
│   └── normalisation.service.ts      # Input normalisation (Claude)
├── expert-search.module.ts
├── expert-search.resolver.ts
└── expert-search.service.ts          # Pipeline orchestrator
```
