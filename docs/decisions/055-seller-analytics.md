# ADR 055: Seller analytics

**Status:** Accepted (2026-10-09).

**Code:**

- API: `apps/api/src/analytics/seller/`
  - `AnalyticsTracker`: the live counters;
  - `AnalyticsRollupService`: the nightly job;
  - `SellerAnalyticsService`: the screen;
  - `analytics-summary.templates.ts`: the headline.
- Hooks in post views, contacts (post and store), saves, share links, search results, map previews and store pages.
- Database: `infra/migrations/0051_seller_analytics.sql`
- Tests: `apps/api/test/analytics.e2e-spec.ts`, `analytics.db-spec.ts`, `src/analytics/seller/seller-analytics.spec.ts`

## Context

This is the screen that later sells boosts and subscriptions. In one glance the seller must see "people found you, and
this many contacted you".

What existed before:

- `lead_events`, one row per contact reveal, scrub-aware;
- a lifetime `posts.view_count`;
- `search_queries.clicked_post_id`;
- an empty `lead_daily_stats`: its nightly rollup was planned in 0009 but never built.

There were no daily views, no unique people, and no record of search appearances, map taps or share opens.

## Decision

### Metrics

Per post, and per store (its own page and contacts plus all its posts):

| Metric              | Source                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| views               | a counted post view (deduped per viewer, never the seller's own); a store page view (same dedupe) |
| unique viewers      | per-day HyperLogLogs, counted exactly over the period                                             |
| contacts by channel | call / whatsapp / sms, plus chat (`chat_started`) when chat lands in week 11                      |
| unique contacters   | per-day HyperLogLogs                                                                              |
| saves               | a new save of the post or store                                                                   |
| shares              | an opened share link (`GET /s/:code`)                                                             |
| search appearances  | a results page a person saw listed it                                                             |
| map taps            | its pin's preview was opened                                                                      |
| conversion          | contacts ÷ views                                                                                  |

### Today live, history pre-aggregated

**Live (Redis, `AnalyticsTracker`).** Each event is one round trip:

- a per-day hash per post or store;
- the day's "touched" set, so the rollup never scans keys;
- HyperLogLogs of distinct viewers and contacters per post, per store and per author member.

Recording is fire-and-forget: a counting failure is logged and never fails the request. Counters live for
`analytics_counter_retention_days`; sketches live for `analytics_unique_retention_days`, which is twice the longest
period so the previous-period comparison is exact too.

**Nightly (`rollup-analytics`, 00:30 Dhaka).** For each of the last `analytics_rollup_days_back` finished days, oldest
first, idempotently:

1. `analytics_rollup_leads()` writes that day of `lead_events` into `lead_daily_stats` (the missing rollup) and returns
   the contacts. This is **the only read of `lead_events`**, and it skips nothing: scrubbed leads carry their flag.
2. Each touched entity's counters, sketch counts and lead contacts become one `analytics_daily` row. Contacts come only
   from `lead_events`, which is authoritative.

**The screen** reads finished days from `analytics_daily` (`seller_daily_metrics()`). It reads today, and yesterday
until the rollup has run, from Redis. **It never reads `lead_events`.**

Days are local days in the schedule zone (`Asia/Dhaka`), the same midnight the job uses.

### Who sees what

`seller_scope_posts()` (SECURITY DEFINER) is the one rule:

- **A store's numbers:** its owner and accepted managers, in the store's tenant. Editors don't see them (`AE250` → 403
  `ANALYTICS_FORBIDDEN`).
- **"My posts":** the caller's own posts in every tenant, so a seller active in two areas sees one total.

`analytics_daily` itself is staff- and system-only under RLS.

### Scrubbed data

- A privacy scrub flags the post's `analytics_daily` rows (`posts_scrub_analytics` trigger), as `scrub_post` already
  flags `lead_events` and `lead_daily_stats`.
- Every reader skips flagged rows and scrubbed posts, today's live counters included: the scope never contains a
  scrubbed post.

### Top posts and queries

- **Top posts:** the period's most viewed (then most contacted), `analytics_top_posts` of them, each with its own
  metrics.
- **Top queries:** the searches whose results were clicked through to these posts (`search_queries.clicked_post_id`),
  shown only when at least `analytics_query_min_searchers` different people made them, because a lone query could be
  personal.

### The headline

A plain-language line in Bengali (and English), worded in one template file with South Asian grouping and Bengali
digits:

> গত ৩০ দিনে ১,২৪০ জন আপনার পোস্ট দেখেছেন, ৪৭ জন যোগাযোগ করেছেন।

It counts **people** (distinct viewers and contacters), not views. There are zero-state variants ("এখনও কেউ…"). The
digit-grouping code was moved out of the share-image templates into `common/text/bengali-numerals.ts`, one helper for
both.

### API

`GET /api/v1/stores/:id/analytics?period=` and `GET /api/v1/posts/me/analytics?period=`.

- **Periods:** `analytics_periods_days` (7/30/90); the first is the default.
- **Response:**
  - `summary`;
  - `totals` and `previous`, plus `trend` (% change, null without a previous number);
  - `daily` (views and contacts per day);
  - `topPosts` and `topQueries`.

## Consequences

- Page loads read at most the period's rows plus one Redis pipeline. The heavy work is the nightly job.
- If Redis loses a day before its rollup, that day's views and taps are gone. Contacts aren't, because they come from
  `lead_events`. Unique counts then fall back to the sum of daily uniques, an upper bound.
- A store's numbers add its posts up at read time. A premium catalog (up to 2,000 posts × 90 days) is the largest read;
  revisit with a per-store daily row if it gets slow.
- **Not built:**
  - the screens (app, web);
  - per-post analytics on the post page;
  - exports;
  - a retention purge for `analytics_daily`. The rows are small, but add one before a year of history accumulates.
