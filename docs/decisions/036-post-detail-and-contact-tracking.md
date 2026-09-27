# ADR 036 — Post detail, contact tracking, views, share links and reports

**Status:** Accepted (2026-09-28). Code: `apps/api/src/engagement`, migration 0031 (`post_short_links`,
`report_post`, `post_seller_card`, `post_engagement_counts`, `add_post_views`, `resolve_short_link`),
`apps/web/src/app/s/[code]`. Builds on ADR 029 (posts), 030 (moderation), 035 (feed). Tests:
`apps/api/test/post-engagement.db-spec.ts`, `apps/api/test/engagement.e2e-spec.ts`, `apps/api/src/engagement/*.spec.ts`,
`apps/e2e/tests/web-share.spec.ts`.

The buyer's side of a post: `GET /posts/:id/detail`, `POST /posts/:id/view`, `POST /posts/:id/contact`,
`POST /posts/:id/report` and `GET /s/:code`. Contact reveals are the foundation of lead billing.

## Decisions

**1. The seller's number leaves the API only through `POST /posts/:id/contact`.**

- Neither the detail response nor `GET /posts/:id` carries it for anyone but the owner and staff. The public view of
  `GET /posts/:id` used to return it when `showPhone` was on; that was a scraping route and is closed. The e2e test
  looks for the number in every spelling (E.164, local, digits only, Bengali digits).
- The detail says which channels are on offer (`call`, `sms` with `showPhone`; `whatsapp` also needs `showWhatsapp`),
  and whether the tenant asks guests to sign in first (`require_login_for_contact`, default off, tenant-overridable).
- Every reveal writes a `lead_events` row in the post's owning tenant: channel (`call_click`, `whatsapp_click`,
  `sms_click`), source (default `post_detail`), post, store, seller (`target_member_id`), the viewer (`actor_member_id`
  when they are a member there) and a viewer key (`anon_session_hash`, below).
- A repeat tap by the same viewer on the same channel within `lead_dedupe_minutes` returns the number again without a
  second lead: a double tap is not two leads, and billing will count real ones.
- New reveals are capped per viewer by `contact_reveals_per_user_per_day` (rolling 24 h, in Redis), so walking the
  endpoint doesn't harvest numbers either. A refused or failed request gives its claim and count back.
- The payload is ready to open: `tel:`, `sms:` with a body, or a `wa.me` link. The prefilled message names the app and
  the listing and carries the share link. It is Bengali unless the client asks for English (`Accept-Language: en`); the
  wording lives in `contact-message.templates.ts` (rule 6), as the OTP SMS does.

**2. One viewer key for dedupe and limits.** `viewerKey()` is an HMAC (server secret) of the signed-in user, else the
client's own install id (`X-Install-Id`), else IP + user agent. It is stable per viewer and can't be reversed into a
user id or an IP.

**3. Views never touch Postgres per request.**

- `POST /posts/:id/view` claims `view:<post>:<viewer>` with `SET NX EX` (`view_dedupe_hours`). Only a first claim adds
  one to a Redis hash of pending counts. The owner's own views and non-public posts never count.
- The `flush-post-views` job (posts queue, every minute) moves the hash aside atomically (Lua `RENAME` + `SADD`) and adds
  the counts through `add_post_views` (0031, system only), `job_batch_size` posts per transaction.
- Each chunk is taken off the batch right after its commit. A crash re-sends at most the chunk in flight (at-least-once),
  and a batch a run left behind is picked up first next time.
- `view_count` is search "noise" (0020), so a flush never reindexes a post.

**4. Detail in one response, read as the caller in the post's owning tenant.**

- The same visibility as `GET /posts/:id`.
- Fields are rendered with the labels and option labels of the schema version the post pinned
  (`posts.field_schema_id`), never the category's current one.
- Every photo comes with every variant (thumb, card, full: URL, width, height) and its thumbhash.
- The seller card comes from `post_seller_card` (0031): name, member since, badges (`trusted` at
  `trust_auto_approve_threshold`, `phone_verified`, `verified_store`), the store, and a response hint. Trust scores
  are private under RLS, so the function returns only the yes/no, never the score. The response hint is null until chat
  (months 3–5) gives it data.
- Distance comes from the viewer's `lat`/`lng`, measured on the sphere like the feed.
- Similar posts reuse the feed's ranking (`FeedService.similarPosts`: same category, `post_similar_radius_km`,
  `post_similar_max`, across tenant boundaries by radius, rule 10) without the post itself.
- The seller-facing counters (views, contacts by channel, saves) come from `post_engagement_counts` (0031), for the
  author and staff only. Nobody else gets the `stats` key at all.

**5. Share links are one short code per post.**

- `post_short_links` is tenant-scoped, with RLS. A code is unique across tenants: lowercase letters and digits without
  look-alikes, `share_code_length` long.
- The code is created the first time anyone needs it, by whoever can see the post: the insert policy checks the post
  through the inserter's own posts policies, so a visitor can share a live post but can't mint a code for someone's
  draft.
- `resolve_short_link` answers ids only, before any tenant context exists. The post's own visibility applies when it
  is read.
- URLs are `SHARE_BASE_URL_TEMPLATE` with the tenant slug, by default `https://{slug}.<APP_ROOT_DOMAIN>/s/<code>`.
- The web's `/s/[code]` is a read-only preview with the OG card link previews read: title, then price · area ·
  category, the cover's card variant, `og:url` = the share URL.
- A missing link or post shows the not-found page, marked `noindex`. The status stays 200 (a soft 404), because the
  root `loading.tsx` has already streamed by the time the lookup fails, as for every page-level `notFound()`.

**6. Reports auto-hide at the threshold, in one transaction.**

- `report_post` (0031) runs as the reporter, in the owning tenant ('ensure' membership, since reports are filed by
  members). It files the report: one open report per reporter per post, and a repeat returns the open one.
- It then counts the distinct open reporters. At `auto_hide_report_threshold` (an existing setting, 3, tenant-overridable;
  0 = off) a live post goes live → pending, which is the system's edge in `post-state-machine.ts`. In the same
  transaction it writes:
  - a `moderation_actions` row `auto_hidden` / `community_reports`, with no actor and the report ids as evidence
    (rule 13);
  - a queue item with source `report` and reason `reported`, which joins an open item's reasons if there is one;
  - a `post.auto_hidden` outbox event.
- The post row is locked first, so two last reports can't both miss or both cross the threshold.
- We chose pending over a new "hidden by reports" flag. Pending is already out of the feed, search and the map, and
  the moderation queue already handles it.
- The reporter's answer never says how many others reported or whether the post was hidden.
- A moderator's approval of a reported post puts it back with the expiry it had, and dismisses the open reports
  (`dismissed` / `no_action`). A reject or remove upholds them (`actioned` / `content_removed`), which is what trust
  scores count.
- Filing is capped by `reports_per_user_per_day`, and the text by `report_details_max_length`.

## Settings (0031)

`view_dedupe_hours` 24, `post_similar_max` 8, `post_similar_radius_km` 5, `contact_reveals_per_user_per_day` 30,
`require_login_for_contact` false, `share_code_length` 8, `report_details_max_length` 500, `reports_per_user_per_day` 20.
Reused: `lead_dedupe_minutes`, `auto_hide_report_threshold`, `trust_auto_approve_threshold`, `job_batch_size`.

## Consequences

- **Breaking for clients:** a buyer's `GET /posts/:id` no longer carries `contact.phone`. No shipped client read it (the
  public detail screens don't exist yet); the owner's and staff's views are unchanged.
- The owner is not yet notified when reports hide a post: the post simply shows "in review" in My posts.
- The deep link into the app lands with the mobile post detail screen. That step adds the Android App Link for
  `/s/*` (with `/.well-known/assetlinks.json`), and the app resolves the code through `GET /api/v1/s/:code`. Until
  then, a shared link opens the web preview.
- The web preview doesn't record a view: the server can't tell visitors apart. The detail screens will call
  `POST /posts/:id/view` from the client, with `X-Install-Id`.
- The feed migration's (0030) photo-count trigger bumps a post's `updated_at` when photos change. The stale-draft e2e
  fixture now attaches its photo without triggers, so the draft stays 40 days old.
