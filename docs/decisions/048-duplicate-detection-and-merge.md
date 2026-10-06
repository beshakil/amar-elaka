# ADR 048: Duplicate places and stores — detection on create and nightly, and the merge tool

**Status:** Accepted (2026-10-07). Builds on [ADR 047](047-place-contributions-and-claims.md).

**Code:**

- API: `apps/api/src/places/duplicate-score.ts` (scoring), `duplicates.{repository,service,controller,processor}.ts`,
  `places-worker.module.ts`; the create check in `places.service.ts`
- Migration: `0043_duplicate_detection_and_merge`
- Tests: `src/places/duplicate-score.spec.ts`, `test/duplicates.db-spec.ts`, `test/duplicates.e2e-spec.ts`

## Context

Duplicate places are the directory's biggest data-quality problem: an agent and a user map the same shop with two
spellings ("মায়ের দোয়া স্টোর" / "মায়ের দোআ ষ্টোর"), and its saves, reviews and leads split between the two copies.

## Decision 1: signals from the database, score in the API

`place_duplicate_signals()` and `store_duplicate_signals()` are SECURITY DEFINER functions. They return everything
within `duplicate_radius_m` (default 150 m) of a point, **in any tenant**: rule 10 says the boundary decides
ownership, never visibility, and a duplicate across the boundary is still a duplicate.

Excluded: deleted, merged or rejected places, and closed stores.

For each candidate they return:

- **Name similarity:** the best pg_trgm `similarity()` over the Bengali, the transliterated (`name_translit`) and the
  English name keys. Latin keys are also cross-compared, so "Mayer Doa Store" matches "মায়ের দোয়া স্টোর".
  - A key is the lower-cased name without `duplicate_name_stopwords` (store, ষ্টোর, ফার্মেসি, hotel…, tenant-admin
    override). Every second shop is a "store", which otherwise makes রহিম and করিম look alike (0.47 → 0.11).
  - Words split on whitespace and explicit punctuation, not `[[:punct:]]`, because under C.UTF-8 that class also
    matches the Bengali virama and would split every conjunct.
- **Phone overlap:** the strongest single signal.
- **Same category** (places only).
- **Distance.**

`duplicate-score.ts` (pure, unit-tested) turns the signals into a score:

- `score = min(1, name + (shared phone ? duplicate_phone_bonus : 0)) × (different category ? duplicate_category_mismatch_factor : 1)`
- **likely** at `duplicate_likely_score` (0.8) or above; **possible** at `duplicate_possible_score` (0.45) or above.
- Distance is the gate (the radius), not a weight.

Calibration on real pairs:

| Pair                                      | Name score | Phone | Class    |
| ----------------------------------------- | ---------- | ----- | -------- |
| two spellings of one shop                 | 0.62       | —     | possible |
| two spellings of one shop                 | 0.62       | same  | likely   |
| রহিম স্টোর / করিম স্টোর (different shops) | 0.11       | —     | none     |

`name_translit` is a stored column because transliteration lives in TypeScript (`search/text/transliterate.ts`). It
is written on create and edit, and backfilled nightly.

## Decision 2: on create — block likely, queue possible

`POST /places` runs the check before inserting.

- **Likely duplicate, already published:** the request fails with `409 PLACE_LIKELY_DUPLICATE`, and
  `details.candidates` lists the existing places (name, location, distance, score, phone match). That is the "is this
  the same place?" prompt.
- **Overriding it:** the contributor resends with `confirmNotDuplicate: true` to add it anyway; the pair still goes to
  moderators.
- **Pending candidates** are never shown in the prompt, since that would leak someone's unreviewed submission; they
  are queued instead.
- **Possible duplicates** are created and queued.

`duplicate_candidates` is the queue: tenant-scoped (staff read and resolve, the system files), one row per pair ever,
whichever side was flagged. A dismissed pair is never flagged again.

## Decision 3: nightly batch

`detect-duplicates` runs on a new `places` queue at 03:30 Dhaka time, within the JobRunner budget (ADR 031):

1. Backfill `name_translit` for places and stores that lack it.
2. Check every place and store created or changed within `duplicate_batch_lookback_hours` against its neighbours.

Stores are only checked here, since there is no store-creation API yet; when one exists it calls the same check.

## Decision 4: merge and undo, one transaction each

`POST /places/:id/merge-into/:targetId` (staff, both places in their tenant) calls `merge_place()`. It moves to the
target:

- photos (after the target's own);
- revisions (the immutability trigger allows a merge to change `place_id` and nothing else);
- saves (one per user);
- reviews (unless the reviewer already reviewed the target);
- lead history;
- pending claims (a claimant who already has one on the target loses the copy, rejected as `duplicate`);
- an approved claim with its store pin. If both places have verified owners, the merge is refused (409).

The loser stays as a **redirect record**: `merged_into_place_id` is set and the row is soft-deleted, so search drops
it. `GET /places/:loser` answers with the target and `redirectedFrom`.

`place_merges` records exactly what moved, and `moderation_actions` logs `merged`.

`POST /place-merges/:id/undo` within `merge_undo_days` (30) calls `undo_place_merge()`. It moves back everything
recorded that still sits on the target, restores the loser, reopens the pair, and logs `merge_undone`. It is refused
after the window, when already undone, or when the target has since been deleted or merged again.

Reports, verifications and local-info rows that point at the loser stay where they are; the redirect resolves them.

## Settings (rule 9)

| Setting                              | Default                             | Override     |
| ------------------------------------ | ----------------------------------- | ------------ |
| `duplicate_radius_m`                 | 150                                 | platform     |
| `duplicate_likely_score`             | 0.8                                 | platform     |
| `duplicate_possible_score`           | 0.45                                | platform     |
| `duplicate_phone_bonus`              | 0.4                                 | platform     |
| `duplicate_category_mismatch_factor` | 0.7                                 | platform     |
| `duplicate_candidates_max`           | 5                                   | —            |
| `duplicate_name_stopwords`           | store, ষ্টোর, ফার্মেসি, hotel… (35) | tenant admin |
| `duplicate_batch_lookback_hours`     | 48                                  | —            |
| `merge_undo_days`                    | 30                                  | platform     |
