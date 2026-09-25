# ADR 029 — Posts module: state machine, ownership, moderation, idempotency

**Status:** Accepted (2026-09-25). Code: `apps/api/src/posts`, migration 0026.

## Decisions

**1. One state machine** (`post-state-machine.ts`). Every status change passes through `assertTransition(from, to,
actor)`. An illegal change raises `POST_ILLEGAL_TRANSITION` (409) with `{from, to, actor}` in `details`.

| From → To                             | Actor              | How                                                        |
| ------------------------------------- | ------------------ | ---------------------------------------------------------- |
| draft → pending                       | owner              | `POST /:id/submit`, or `submit: true` on create            |
| pending → live                        | moderator / system | system = post-moderated tenant (below)                     |
| pending → rejected                    | moderator          | moderation queue (later)                                   |
| rejected → pending, removed → pending | owner              | edit, then `POST /:id/submit`                              |
| live → sold                           | owner              | `POST /:id/sold`                                           |
| live → expired                        | system             | the expiry sweep (worker, every 15 min)                    |
| live → removed                        | moderator          | moderation queue (later)                                   |
| live → pending                        | system             | after the owner's edit to a re-review field, pre-moderated |
| expired → live                        | owner              | `POST /:id/repost` (fresh `expires_at`)                    |

Soft delete (`deleted_at` + `deletion_reason_code = user_deleted`) and `hidden_by_owner` sit beside the machine and
never touch `status_code`. A **sold post can't be deleted**. It is sales history (schema §H 1a), so the owner hides
it instead.

**2. Moderation mode.** The effective mode is the **stricter** of the category's mode in that tenant
(`tenant_categories.moderation_mode_code`, else the category default) and the tenant's `post_moderation_mode_code`.

- `post`: a submitted draft goes live immediately (`pending → live` by `system`, same transaction).
- `pre`: it waits in `pending`.
- A beyond-buffer post (`beyond_buffer_fallback`) always waits, whatever the mode.
- A post a moderator rejected or removed always goes back to a human on resubmit. Auto-publishing it would silently
  override the moderator.

**3. Re-review on edit.** `post_rereview_fields` (a `text_array` setting; default title, media, price, category) says
which edits count. On a live post, such an edit sends it back to `pending` in a pre-moderated tenant (or a
beyond-buffer post). In a post-moderated tenant it stays live, and `post.edited` carries `rereview: true` for the
moderation queue. Location edits never move a post to another tenant (§13.26).

**4. Ownership (§13.26).** `resolve_owning_tenant` (0023) picks the tenant, and the caller's implicit membership there
is created by `ensure_my_membership` (0026). Every read and write of a post then runs in its owning tenant's context
with the caller's own role there (`PostOwnershipService.inTenant`), so the existing RLS policies decide everything.
This is also how a neighbour tenant's live post opens from radius search.

**5. Photos across tenants.** A photo belongs to the tenant it was uploaded in, and `media_attachments` requires the
same tenant as the post. A buffer-zone post would therefore fail with photos uploaded in the request's tenant. So:
`GET /posts/ownership?lat&lng` tells the app the owning tenant _before_ it uploads (and lets it show "this will be
listed in <area>"). A mismatch is answered with `POST_MEDIA_TENANT_MISMATCH` and the tenant to upload to.

**6. Idempotency-Key on create.** Stored in Redis for `post_idempotency_ttl_hours` (default 24), per user, keyed by
the request hash:

| Situation                               | Answer             |
| --------------------------------------- | ------------------ |
| Same key, same body, first request done | the same post, 200 |
| First request still running             | 409                |
| Same key, different body                | 422                |

Built for Bangladeshi mobile data, where a create that timed out on the phone often succeeded on the server.

**7. Limits** (all settings, across every tenant, counted under a per-user advisory lock so two taps can't both
pass):

| Setting                       | Default | Counts                  |
| ----------------------------- | ------- | ----------------------- |
| `post_max_active_per_user`    | 50      | pending + live          |
| `post_max_per_day_per_user`   | 10      | creations, rolling 24 h |
| `post_max_media`              | 10      | photos per post         |
| `post_title_max_length`       | 120     | characters              |
| `post_description_max_length` | 5000    | characters              |

**8. Listing period.** `expires_at` is set when a post goes **live**, not when it is created, so time in the
moderation queue doesn't eat the seller's listing period. It uses the tenant's category override, else the category
default, else `post_expiry_days_default`.

**9. Domain events.** `post.created`, `.submitted`, `.live`, `.edited`, `.sold`, `.expired`, `.reposted`, `.hidden`,
`.unhidden` and `.deleted` go into `outbox_events` in the same transaction as the change. Search already syncs through
the `search.sync` triggers (0020), and the search relay only claims `search.*`. So these events are for saved-search
matching and notifications. **Until a consumer exists they accumulate unprocessed**, and the outbox purge only
removes processed rows.

## Consequences

- Moderator endpoints (approve, reject, remove, restore) are the moderation queue's job. `removed` requires a
  `moderation_actions` row in the same transaction (ADR 005), so it can't be added as a bare status write.
- The DB still lets an author write any column of their own post, so the state machine is enforced in the API only.
  A DB trigger guarding `status_code` would be defense in depth.
