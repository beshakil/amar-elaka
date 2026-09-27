# ADR 037 — Saved items, store follows, store-activity metric, price-drop event

**Status:** Accepted (2026-09-28). Code: `apps/api/src/saved`, `apps/api/src/analytics`,
`apps/api/src/posts/price-drop.ts`, migration 0032. Implements Q25 (schema.md §13.29); builds on ADR 036. Tests:
`apps/api/test/saved-items.db-spec.ts`, `apps/api/test/saved.e2e-spec.ts`, `apps/api/src/posts/price-drop.spec.ts`.

## Decisions

**1. A saved item is a row in the target's tenant; the list crosses tenants (§13.29).**

- `saved_posts` (0005) is joined by `saved_places` and `saved_stores`, with the same shape: `tenant_id` NOT NULL, and
  RLS in which a user reads and deletes their own rows from any tenant context.
- The insert policies of the new tables also require the target to be visible to the inserter. The API checks the same
  for all three.
- The API writes the row in the target's owning tenant as the caller (`PostOwnershipService.inTenant`, `lookup` mode),
  so saving something never creates a membership.

**2. Endpoints.**

- `POST /saved/:itemType/:itemId` (`post | place | store`) is idempotent: 201 when saved now, 200 when it already was.
  Only public targets can be saved: a live or sold post, a published or temporarily closed place, an active store.
  Anything else is 404. Your own post or store is 409 `SAVE_OWN_ITEM`, since saving it would only inflate its own
  counter.
- `DELETE /saved/:itemType/:itemId` is idempotent (204).
- `GET /saved?type=&cursor=&limit=` returns the newest first. Page sizes are `saved_page_size_default` and
  `saved_page_size_max`.
- `POST` and `DELETE /stores/:id/follow` are idempotent and return `followerCount`. An unfollow returns `null` when the
  store is no longer public. Your own store is 409, and a store that isn't active is 404.
- The post detail (ADR 036) now says `isSaved` for the caller.

**3. A saved item never silently disappears.**

- `my_saved_items` (0032, SECURITY DEFINER, only for `current_user_id()`) returns every save with its **state**:

| Item  | States                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Post  | `available`, `sold`, `expired`, `unavailable` (hidden, in review, rejected), `deleted` (by its author), `removed` (by a moderator) |
| Place | `available`, `temporarily_closed`, `closed`, `unavailable`                                                                         |
| Store | `available`, `closed`, `unavailable`                                                                                               |

- The card data follows the state:
  - price and area: only while a buyer may still look at the item (available, sold, expired, and a closed place or
    store);
  - cover photo: in those states too, but only while the photo itself is still public;
  - title: while the item exists and wasn't taken down;
  - nothing but the state for a removed post.
- **`scrub_post` no longer deletes the post's saves** (chosen in the Q25 follow-up). The row stays, and the list shows
  "removed" with nothing of the scrubbed content. Before, a moderator's hard removal made the item vanish from
  everyone's list.

**4. Counters are kept by triggers, and a save never reindexes.**

- `posts.saved_count` and `stores.follower_count` are kept by `AFTER INSERT OR DELETE` triggers (SECURITY DEFINER,
  since the saver can't write someone else's row), and were backfilled in the migration.
- The triggers add or subtract 1 rather than recount. The UPDATE row-locks the target, and a concurrent increment
  re-reads the latest row version, so no save is lost.
- Both columns are search "noise" (0020): `posts_search_sync` and `stores_search_sync` ignore them. New
  `stores_zz_search_carry_synced` (like the posts one) keeps a store the sweeper considers in sync when only its
  counter changed, even though `set_updated_at` moved `updated_at`.

**5. No following feed: first a number to decide on.**

- `tenant_store_activity(months)` (0032) returns, per Dhaka calendar month, newest first:
  - active stores;
  - how many of them posted;
  - their posts;
  - **average posts per active store**;
  - average per posting store.
- It is for tenant admins, marketers and platform staff (the `analytics:read` grant, and the function checks the role
  itself). Months are clamped by `store_activity_months_max`.
- It is read through `GET /tenant/analytics/store-activity?months=`, as JSON only, with no dashboard.
- **Known approximation:** there is no store status history, so "active" means active **now** and created by the
  month's end. A store closed since doesn't count for earlier months either.

**6. `post.price_dropped` is groundwork; delivery comes in week 11.**

- `PostsService.update` writes the event into the outbox, in the edit's transaction, when:
  - a live, not-hidden post stays live (not sent back to review);
  - and its price went down.
- Prices are compared as integer poisha (`isPriceDrop`, `toPoisha`), never as floats.
- Payload: `tenantId`, `actorUserId`, `from`, `to`, `categoryId`. Week 11 fans it out to the post's savers.
- A price that appears or disappears is not a drop. A drop while the post waits for review emits nothing, because
  buyers can't see it yet.

## Settings (0032)

`saved_page_size_default` 20, `saved_page_size_max` 50, `store_activity_months_default` 6, `store_activity_months_max` 24.

## Consequences

- The seed gives the demo buyer saved posts, places and a store, and two follows.
- No client UI yet: the saved list and follow buttons come with the detail screens (web week 10, app).
- A save or follow moves the target's `updated_at`, as a view flush does (ADR 036). Nothing ranks or expires on
  `updated_at` for live posts, and the carry triggers keep search from reindexing.
