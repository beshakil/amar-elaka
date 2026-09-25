# ADR 025: Search: shared Meilisearch indexes, Bengali/Banglish/English matching, outbox sync

**Status:** Accepted
**Date:** 2026-09-25
**Schema:** [§11.8 `outbox_events`](../specs/schema.md), [§13.26](../specs/schema.md), settings in §2.16
**Spec:** [search-synonyms.md](../specs/search-synonyms.md)
**Code:** `apps/api/src/search/`, migration `0020_search_infrastructure`

## Context

People search in three ways, often in the same query, and often misspelled:

- Bengali script: ডাক্তার;
- Banglish, Bengali typed in Latin letters: daktar, dakter;
- English: doctor.

All three must find the same listings. Search must also:

- filter by category and custom fields, with facets for the filter UI;
- work by radius ("near me");
- rank exact match > boosted > nearby > recent;
- keep the app working when Meilisearch is down.

## Decision 1: one index per document type, shared by all tenants

We use three indexes: `posts`, `stores` and `places`. Every tenant shares them, and `tenant_id` is a filterable
attribute. We do not create an index per tenant.

- **Discovery crosses tenant boundaries** (§13.26: boundaries decide ownership, never discovery). A post in a buffer zone
  must appear for someone just across the upazila line. With an index per tenant, every "near me" query would have to
  search all the neighbouring indexes and merge the results by hand, and a hand merge breaks facet counts, paging and
  ranking. With one index it is a single `_geoRadius` filter.
- **Operations scale with the number of types, not tenants.** There will be hundreds of tenants, so an index per tenant
  would mean hundreds × 3 indexes. Every change to synonyms, ranking or settings, and every reindex, would then run
  hundreds of times, on a single VPS.
- **Filtering by tenant is cheap.** Meilisearch applies filters as a bitmap before ranking, so a `tenant_id` filter costs
  almost nothing at our scale (up to millions of documents).
- **Isolation still holds.** The index contains only public-state rows (live posts, active stores, published places) and
  only public fields, never phone numbers. Without a location, the API always filters by the request's tenant. With a
  location, it applies the radius alone, exactly as §13.26 specifies.

We would revisit this only if a single tenant needed its own ranking or synonyms, or if the index outgrew one machine.

## Decision 2: three-script matching comes from four layers

1. **Normalisation**, applied the same way on both sides (`text/normalize.ts`):
   - NFC, since ো can be typed as ে + া, and nukta letters have two encodings;
   - zero-width joiners and non-joiners removed;
   - the old khanda-ta spelling mapped to ৎ;
   - Bengali digits turned into ASCII;
   - Latin lower-cased.
2. **Transliteration** (`text/transliterate.ts`) turns Bengali into Banglish the way people actually type it:
   - ডাক্তার → daktar, বাসা → basa;
   - schwa deletion (মিরপুর → mirpur, সবজি → sobji);
   - conjuncts, reph and the ya/ra/ba-phala.

   It also produces spelling variants (স as s/sh, ভ as bh/v, the inherent vowel as o/a, ফ as ph/f, a final conjunct with
   or without its vowel), so basha, shobji and karim match too.

3. **The synonym dictionary** ([search-synonyms.md](../specs/search-synonyms.md)) holds what phonetics can't produce:
   English equivalents (ডাক্তার = doctor, ইলেকট্রিশিয়ান = electrician), different words for the same thing
   (বাসা = বাড়ি), and far-apart spellings (chattogram = chittagong). It is used in three places: as Meilisearch synonyms,
   to put English equivalents into documents, and in the degraded search. Locality aliases are added automatically.
4. **Typo tolerance tuned for Bengali.** Meilisearch counts word length in Unicode code points, and Bengali words are long
   in code points (ডাক্তার has 7). The common slips are one sign (ি/ী, a missing hasanta). So we allow one typo from 4
   code points and two from 8, instead of 5 and 9. Both thresholds are settings.

Every document carries:

- `name_bn`, `name_en` and `name_translit`;
- `name_variants`, which is searchable but never displayed;
- category and area names, each with a translit;
- the description, and `field_text` (select-option labels in both languages);
- `text_translit`: the Banglish of every other Bengali word in the document.

**Query expansion.** A short query containing Bengali is sent as its Banglish first, then the original:
"ডাক্তার রহিম" becomes "daktar rohim ডাক্তার রহিম". This lets a Bengali query reach a listing written in Latin letters
("Dr. Rahim's Chamber"). Meilisearch's "last" strategy drops words from the end but never the first. `text_translit` is
what makes this safe: any document that contains a Bengali word also contains that word's Banglish, produced by the same
algorithm.

## Decision 3: ranking

The ranking rules are:

`words, typo, proximity, attribute, exactness, is_boosted:desc, sort, published_at:desc`

- The text rules come first, so a better match always wins: fewer typos, words closer together, a match in the name
  rather than the description.
- Among equally good matches, boosted listings come first.
- Next is `sort`: when the request includes a location, the API always sorts by `_geoPoint`, and this is the "nearby"
  step. Otherwise it applies the user's chosen sort (price, rating).
- The newest listing breaks any remaining tie.
- With an empty query (browsing), the text rules tie, so the order becomes boosted > nearby > recent.

`test/search.meili-spec.ts` checks the order exact > boosted > nearby > recent against a real engine.

## Decision 4: geo from PostGIS, and a Postgres fallback

- `_geo` comes from PostGIS. For a post it is the post's point, else its locality's centre, else its area's centroid, so
  a post without a pin still shows up in radius searches. For a store it is the store's point, else its place's point.
- Custom fields are indexed under `fields.<key>`, which Meilisearch makes filterable and facetable. Money is stored as an
  integer in poisha and dates as yyyymmdd, never as floats. Field filters reuse the category engine's `parseFieldFilters`,
  so search and the SQL fallback accept exactly the same filters.
- **When Meilisearch is down**, `GET /search` answers from Postgres with `degraded: true`:
  - it covers only the current tenant, because we never bypass RLS and cross-tenant reads need the index;
  - it uses substring matching, expanded through the dictionary and transliteration;
  - there are no facets.

  A 10-second circuit breaker stops every request from waiting out the timeout during an outage. Suggestions fall back to
  category matches only.

## Decision 5: sync through the transactional outbox

- **HTTP requests never write to Meilisearch.** Migration 0020 adds triggers that write `search.sync`, `search.resync` and
  `search.settings` events into `outbox_events`, in the same transaction as the change. They fire on posts, stores and
  places, and on everything denormalised into documents: boosts, categories, tenant category switches, localities,
  member bans, and photos. Nobody can forget to emit an event, and a rolled-back write emits nothing.
- **The worker relay** runs every 2 seconds:
  - it claims `search.%` events with `FOR UPDATE SKIP LOCKED` and a lease, so several workers can run safely;
  - it reloads each row's current state, then upserts it or removes it. Events are therefore idempotent and their order
    doesn't matter;
  - it waits for the Meilisearch task to finish before marking events processed;
  - on failure it backs off exponentially, and after `search_outbox_max_attempts` it parks the event for a human to look
    at.
- **A safety net:** a sweeper runs every 15 minutes and re-syncs rows whose `search_synced_at` is older than
  `updated_at`. A BEFORE trigger keeps view-count updates from counting as changes.
- **`pnpm --filter @amar-elaka/api search:reindex [--type posts,…]`** rebuilds with zero downtime:
  - it fills a fresh `<index>__reindex` while the live index keeps serving;
  - it swaps the two atomically and drops the old one;
  - it then re-syncs rows that changed during the rebuild.

  In the production image, run `node dist/search/cli/reindex.js`.

## Consequences

- **After the first deploy**, run `search:reindex` once. Until then only the sweeper would fill the index, slowly, in
  batches of 500 every 15 minutes.
- **Freshness:** a change reaches search within about 2 seconds.
- **The dictionary is a product asset.** Adding a line to `search-synonyms.md` and running `search:synonyms` is enough;
  the worker applies the new synonyms on its next start.
- **Index size:** translit and variants roughly double the text stored per document. That is acceptable at hyperlocal
  scale.
- **Dev tooling:** `pnpm --filter @amar-elaka/api test:search` runs the real-engine suites. CI runs them against
  `getmeili/meilisearch:v1.8`, the same image as `docker-compose.dev.yml`.
- **Known limits:**
  - Bengali ↔ Latin matching of proper names relies on transliteration plus typo tolerance, so an unusual spelling of a
    name can still miss.
  - The degraded mode doesn't do cross-tenant radius discovery.
  - Meilisearch 1.10+ `localizedAttributes` could tighten tokenisation further if we upgrade.
