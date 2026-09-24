# ADR 006: Scrub and hide instead of blocking deletion of sold posts

**Status:** Accepted (Q36), amended by Q44 (location) and Q46 (links); additions confirmed (CONFIRM 3)
**Date:** 2026-09-17
**Schema:** [§4.2 `posts`](../specs/schema.md), [§3.4 `category_field_schemas.analytics_fields`](../specs/schema.md), [§13.31](../specs/schema.md), tests §15.3 L

## Context

Sold posts are our price-history dataset (Q34). The first design protected them with a CHECK that made
a sold post undeletable. That fails two real needs: a seller exercising a privacy request, and a
moderator hard-removing illegal content that happens to be marked sold.

## Decision

1. **Drop** the CHECK that blocked deleting a sold post.
2. **Owner hide** (`posts.hidden_by_owner`) is reversible: the post disappears from the owner's own list
   and every public surface; the row is fully intact and still counts in analytics.
3. **Scrub** (`posts.scrubbed_at`, `posts.scrub_reason`) is irreversible, runs in one transaction, and is
   logged in `moderation_actions` (`privacy_scrub`, or as part of `moderator_removed`):
   - **Clears:** title, description, `fields` except whitelisted analytics keys, `contact_phone_e164`,
     `contact_name`, and all media (rows soft-deleted, files purged immediately via
     `scrub_media_purge_days = 0`).
   - **Also clears (added, needed to make "can't identify the seller" true):** `author_member_id`,
     `store_id`, `locality_id`, and `deleted_by_user_id` when it's the seller.
   - **Location (Q44): `location` → NULL and `geo_area_id` → NULL. No lat/lng at any precision.** Only
     `geo_area_id_coarse` survives: the ADM3 (upazila/thana) ancestor. Price-by-area and days-to-sell analytics run on
     it, which is all they ever needed.
   - **Retains:** `category_id`, `geo_area_id_coarse`, price (the whitelisted `fields.price` → generated `price`, the
     decision's `price_value`), `sold_price`, `sold_at`, `created_at`, `status`, and (confirmed) `published_at` and
     `field_schema_id`.
4. The whitelist is `price`, `bedrooms`, `seats`, `area`, plus each category schema's `analytics_fields`
   (validated at publish to exclude free-text or contact-like fields).
5. **Links (Q46): sever user-facing links, retain billing evidence.**
   - Sever: `conversations.post_id` → NULL with `post_context_removed = true`; cached listing snapshots in messages →
     neutral `{"state":"listing_removed"}` marker; `saved_posts` rows for the post → deleted; `reviews.post_id` → NULL
     (added, or a review card would still link seller and listing); share and deep links → generic "gone" page (`410
POST_REMOVED`), never a 404 carrying the old slug.
   - Retain (never user- or partner-visible): `lead_events` (including call taps; there's no separate `call_logs` table)
     and `lead_daily_stats` keep `post_id` and get `subject_scrubbed = true`, excluded from every partner-facing report,
     seller analytics view and export.
6. Automatic jobs never delete sold posts, and the owner's "delete" on a sold post offers hide or scrub.
   These are enforced by tests now that the DB CHECK is gone.

## Reasoning

- Privacy and analytics aren't in conflict: the price signal (what, which upazila, how much, how fast) doesn't need
  who, where exactly, the photos or the words.
- **Coordinate rounding is not anonymisation.** In a sparse rural upazila a 1 km cell (2 decimals), let alone ~110 m
  (3 decimals), can contain exactly one shop, so a rounded point still identifies the business. Dropping coordinates and
  keeping only the upazila is the only safe option.
- Separating reversible hide from irreversible scrub stops a "tidy my list" click from destroying data, and stops a
  privacy request from being quietly undone.
- Billing and audit evidence must survive a privacy scrub (disputes, fraud, ad and boost attribution), but it must never
  surface anywhere the seller could be recognised.
- An open legal hold blocks the scrub entirely (ADR 012).

## Consequences

- **Tests required** (§15.3 L), shipping with the posts migration:
  - a scrubbed sold post still appears in price analytics with unchanged values;
  - no API response anywhere returns the seller's identity, name, phone, store or media for that post;
  - the lead count used for billing is unchanged.
- **Decided (Q52):** `geo_area_id_coarse` is NOT NULL on every post, set by trigger on create and location change, since
  analytics use it for every sold post, not just scrubbed ones. Upazila is also Bangladesh Bureau of Statistics' reporting
  unit, so price data lines up with official area statistics.
- The `scrub_location_decimals` setting is removed.
