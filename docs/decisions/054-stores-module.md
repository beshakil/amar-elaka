# ADR 054: The stores module

**Status:** Accepted (2026-10-08).

**Code:**

- API: `apps/api/src/stores/` (controller, `StoresService`, `StorePageService`, repository, `store-access.ts`,
  `store-slug.ts`, `store-limits.ts`); posting as a store in `posts/posts.service.ts`; the contact endpoint in
  `engagement/contact.service.ts` (`StoreContactController`)
- Database: `infra/migrations/0050_stores_module.sql`
- Tests: `apps/api/test/stores.e2e-spec.ts`, `stores.db-spec.ts`, `post-visibility.db-spec.ts`,
  `src/stores/*.spec.ts`

## Context

Month 3 needs stores: a seller's branded storefront with an owner, staff, hours, a catalog and a pin on the map.

Most of the storage already existed:

- `stores`, `store_members`, `store_follows` (0006);
- store hours, special days and "closed today" (0044, ADR 049);
- claims that create or link a store (0042, ADR 047).

What didn't exist was the module that runs it, plus several gaps that would have bitten as soon as it did:

- staff roles were `manager | staff`, not `manager | editor`;
- there was no tier, no category, and no record of a slug change;
- the posts API could not post as a store;
- a suspended store's posts stayed in the feed, search and the map;
- a claimed shop was drawn twice on the map (its place and its store);
- the map preview handed out a store's phone numbers with no lead recorded;
- `moderation_actions` could not target a store.

## Decision

### Ownership and area

- A store belongs to the tenant its location falls in, by the **same rule as posts and places**
  (`PostOwnershipService.resolve` → `resolve_owning_tenant`).
- The caller's membership there is created on demand, as for posts.
- A store's area is fixed. A later location must resolve to the same tenant, else `STORE_LOCATION_OUTSIDE_AREA`.
- A store's posts must be in its area (`POST_STORE_OUTSIDE_AREA`).

### Creating a store

`create_store()` (SECURITY DEFINER) does everything in **one transaction**:

- the store;
- its **map pin**: a place claimed by the owner, linked both ways (`places.claim_store_id`, `stores.place_id`, as
  `approve_place_claim` does);
- the logo and banner attachments, so the orphan sweep keeps them;
- the per-owner limit, checked under a lock on the caller's membership row.

The pin never gets the store's phone.

**Status at creation** uses the **same trust gate as a member's map contribution** (`place_contribution_trust_threshold`):

- staff, field agents and trusted members: `active` (pin `published`);
- everyone else, and anything beyond every buffer: `pending_review`, until a moderator approves it.

**Likely duplicates.** A likely duplicate place nearby (ADR 048) holds the creation with the existing
`PLACE_LIKELY_DUPLICATE`. The answer is to claim the place, or to resend with `confirmNotDuplicate`; either way a
moderator sees the pair.

Stores created by a claim keep going through `approve_place_claim`.

### Slugs

- Latin, lower case, 3–60 characters. Generated from the English name, or the Bengali name through the search
  transliteration (`রহিম স্টোর` → `rohim-stor`).
- Unique per tenant (index). A random four-character tail is added when the name's slug is taken.
- `me` and `review-queue` are routes, never slugs (checked in code and by a DB constraint).
- **The owner may change it once.** The database enforces this (`stores_b_protect_tier_and_slug`, `AE240`). The old
  slug is kept in `previous_slug`; it still opens the store (the page carries the current slug for a redirect) and stays
  taken (`store_slug_available()`).

### Roles

Who may do what (`store-access.ts`; the database draws the same lines):

| Action                                                  | Owner | Manager | Editor |
| ------------------------------------------------------- | ----- | ------- | ------ |
| Profile, category, media, location, hours, closed today | ✓     | ✓       | –      |
| Slug (once)                                             | ✓     | –       | –      |
| Invite / remove managers                                | ✓     | –       | –      |
| Invite / remove editors                                 | ✓     | ✓       | –      |
| See the staff list (masked phones)                      | ✓     | ✓       | –      |
| Post as the store                                       | ✓     | ✓       | ✓      |
| Leave the store / decline an invitation                 | –     | ✓       | ✓      |

Database enforcement:

- `can_manage_store` (owner or accepted manager) guards store rows and hours;
- `member_may_post_as_store()` is the one "may post as this store" rule. The posts trigger now calls it (`AE246` →
  403 `STORE_MEMBERSHIP_REQUIRED`), and so does `store_posting_facts()`;
- `store_invite_staff()` decides invitations.

The `staff` role is retired, not dropped. Its rows became `editor` and the lookup row is `is_active = false`.

### Invitations

- **By phone.** `store_invite_staff()` does it in one transaction:
  - the staff limit is checked under the store's row lock;
  - a number with no account gets one, unverified until that person signs in;
  - banned and terminated numbers are refused;
  - a membership is created in the store's tenant;
  - a **pending** `store_members` row is written.
- The invitee gets an in-app notification (`store_staff_invited`) and accepts with `POST /stores/:id/staff/accept`.
  Nothing is visible to them until they accept.
- Every response masks staff phones.

### Tiers

- `stores.tier_code` (`store_tiers`: basic, pro, premium). Only staff or the system can move it.
- The limits are **settings per tier**: `store_staff_max_<tier>` (invited plus accepted staff) and
  `store_catalog_max_<tier>` (draft, in-review and live posts), plus `store_max_per_owner` and
  `store_description_max_length`.
- Everyone is `basic` this month. Paid tiers arrive in week 17; nothing here sells one. `current_plan_code` (billing)
  is untouched.

### Status and discovery

- `active | suspended | closed`, plus `pending_review` for new stores below the trust gate.
- Moderators change it through `POST /stores/:id/status` (`stores:approve`, new for the moderator role). Each change
  writes a `moderation_actions` row in the same transaction (rule 13): `approved`, `store_suspended`,
  `store_reinstated` or `store_closed`. `moderation_actions` gained a `store_id` target.
- **A store that isn't active takes its posts out of discovery through the one visibility rule.**
  - `posts.store_hidden` is kept by triggers: on a post's insert or store change, and on the store's status or
    deletion. An author can't clear it.
  - `post_is_listed()` takes it as a seventh argument. The six-argument version was dropped so no caller can skip it.
    Every caller was updated: `feed_posts`, `map_features`, `heatmap_cells`, `discover_nearby`, search documents, the
    search fallback, the SEO and saved-search queries, and the store page.
  - The partial indexes still match, because they don't mention the new column.
- The post's own lifecycle (`status_code`) is untouched: reinstating brings it back as it was.
- The posts' search sync trigger queues them, so the index drops them on the next relay run. Store documents were
  already indexed only while active.
- The feed and the map cache their answers briefly, so a suspension shows there within `map_features_cache_seconds`
  and the feed cache TTL.

### Map

- `map_features` draws a store's pin **once, as the store**: the places layer skips places with a `claim_store_id`.
  A suspended store's pin is gone completely.
- Stores now follow the category filter, using their own category.
- The map preview no longer returns a store's phones. Calling a store is `POST /stores/:id/contact`, which works like
  a post's contact: one `lead_events` row (`post_id` null, source `store_page`), the same dedupe and the same daily
  limit.

### The public page

`GET /stores/:slug` moved here from the SEO module (one implementation). It keeps every field the web page reads and
adds:

- the category and the map pin;
- the verification badge: `business` for a verified store, else the owner's seller verification;
- stats: followers, live posts, member since;
- hours with the open state (`HoursService` → `is_open_at`);
- catalog filter chips, with `?category=` filtering the catalog (a category and its subcategories, as the feed
  resolves them).

It never carries a phone number.

### Endpoints

| Method  | Path                                 | Who                                                              |
| ------- | ------------------------------------ | ---------------------------------------------------------------- |
| POST    | `/stores`                            | any signed-in member (becomes the owner)                         |
| GET     | `/stores/me`                         | signed in: owned, staffed, invited (every tenant, `my_stores()`) |
| GET     | `/stores/:slug`                      | public                                                           |
| GET     | `/stores/:id/manage`                 | owner and staff                                                  |
| PATCH   | `/stores/:id`                        | owner, manager (slug: owner, once)                               |
| POST    | `/stores/:id/staff`                  | owner (any role), manager (editors)                              |
| POST    | `/stores/:id/staff/accept`           | the invitee                                                      |
| DELETE  | `/stores/:id/staff/:memberId`        | owner, manager (editors), anyone for themselves                  |
| POST    | `/stores/:id/contact`                | public (a lead)                                                  |
| POST    | `/stores/:id/status`                 | moderators                                                       |
| GET     | `/stores/review-queue`               | moderators                                                       |
| POST    | `/stores/:id/closed-today`           | unchanged: HoursController (ADR 049)                             |
| GET/PUT | `/stores/:id/hours`, `/special-days` | unchanged: HoursController                                       |

## Consequences

- One visibility rule, one "may post as a store" rule, one tenant rule and one open-now rule, all reused. No second
  implementation was added.
- Changing `post_is_listed`'s signature touched every discovery query. That's intended: the compiler and the dropped
  overload catch a missed caller.
- **Not built yet:**
  - the store screens in the app and the web (store page follow button, staff management, the invitation inbox text
    for `store_staff_invited`);
  - an owner's own "close my store";
  - store reviews (Month 3, reviews);
  - paid tiers (week 17).
- A suspended store's post pages still open from a direct link; only discovery hides them. A takedown of a single post
  is still the post's moderation.
