# Search reindex

**Last exercised: locally, 2026-10-16.** Against a seeded database: 30 posts, 10 stores, 20 places indexed in **4 s**;
the CLI **exits 0** (Month 2 found it hanging for ever after finishing; it now closes the app and exits).

When: after a restore, a Meilisearch volume loss, a settings change that alters documents (synonyms, searchable
fields), or a document-shape change in a release.

```sh
# in the API container (the image has dist/)
node apps/api/dist/search/cli/reindex.js
# locally
pnpm --filter @amar-elaka/api search:reindex
```

It rebuilds the posts, stores and places indexes from Postgres under `MEILI_INDEX_PREFIX`, then swaps them in. Search
keeps answering from the old index until the swap. Expect roughly 1 s per 10k documents on a server (scale the local
figure). Documents indexed before 0049 lack `expires_at` and match until reindexed.
