# ADR 023: Category engine: JSONB field storage and immutable schema versions

**Status:** Accepted
**Date:** 2026-09-24
**Schema:** [§3.3–3.5](../specs/schema.md), [§4.2 `posts`](../specs/schema.md), [§13.13](../specs/schema.md)
**Spec:** [categories.md](../specs/categories.md)
**Code:** `apps/api/src/categories/` (migrations `0017_category_engine`, `0018_category_versioning`)

## Context

Every category has its own custom fields (bedrooms and rent for to-let, seats and rates for rent-a-car, …), defined by
platform admins without a deploy. Two questions follow:

1. **Where do field values live?** Listings must be filterable on them, e.g. `bedrooms >= 2 AND rent < 15000`, with good
   performance across 100k+ posts per category.
2. **What happens to existing posts when a category's fields change?** A field can be added, removed or restricted at any
   time, and posts written before the change must keep rendering and validating correctly.

## Decision 1: values in `posts.fields jsonb`, not a `post_field_values` table

Keep the §13.13 design and build on it:

- **Range filters on the fields that need them** (`price`, `bedrooms`, `seats`, `area`) use STORED generated columns
  with btree indexes on `(tenant_id, category_id, <column>)`. "bedrooms ≥ 2 AND rent < 15000" becomes an index range
  scan. `test/post-field-filters.db-spec.ts` checks the plan with EXPLAIN on 100k rows.
- **Equality filters** on selects, bools and multiselects use `fields @> {...}`, served by
  `GIN (fields jsonb_path_ops)`.
- **Other ranges** run on rows already narrowed by `(tenant_id, category_id)`. Each comparison is wrapped in a `CASE` on
  the stored JSON type, so a post from an older schema version where a key had another type never makes a cast fail.
- **Meilisearch stays the primary faceted search.** The SQL path (`post-field-filters.ts`) is the fallback, and it is
  what the database guarantees.

EAV (`post_field_values(post_id, field_key, value_text, value_num, …)`) was rejected:

| concern              | JSONB + generated columns                    | EAV                                                      |
| -------------------- | -------------------------------------------- | -------------------------------------------------------- |
| 2-field range filter | one index range scan                         | a join or self-join per filter, then an intersection     |
| writes per post      | one row                                      | one row per field (~10–20×), all in the same transaction |
| types                | the pinned schema says what each key holds   | one value column per type, or casts everywhere           |
| schema versioning    | `fields` and `field_schema_id` move together | values and the schema they were written under can drift  |
| reading a post       | one row                                      | a pivot                                                  |

The cost of JSONB is that the database doesn't enforce the field schema; the API does, on every write
(`FieldValidationService`). A field that later needs fast range filtering gets a generated column in a migration, as
`price`/`bedrooms`/`seats`/`area` did.

## Decision 2: every schema change is a new, immutable version

- `category_field_schemas` rows are versions: **draft → published → retired**, with at most one draft and one published
  row per category. Publishing retires the previous version and publishes the draft in one transaction, under a lock on
  the category row.
- A published or retired row **never changes** (trigger). The only allowed changes are published → retired, and clearing
  the publisher when that user is deleted. The app can delete drafts only (restrictive RLS policy).
- Posts pin `field_schema_id`. A post written under v1 keeps rendering against v1's labels and options, and validating
  against v1's rules, after v2 adds, removes or restricts fields. `GET /categories/schemas/:id` serves any published
  or retired version, so clients can render old posts.
- New posts, and edits, validate against the **current** version and re-pin to it.
- **Parents:** a child's stored schema has its parent's fields merged in, and a child may only _narrow_ an inherited
  field. The admin's own fields are kept in `authored_definition`. When a parent publishes, every descendant is
  re-resolved from its authored definition and republished in the same transaction. If a child's narrowing no longer
  fits, the whole publish fails and nothing changes.
- **Validation cache:** versions are immutable, so compiled validators are cached by schema id and can never go stale.

## Consequences

- Removing a field never loses data: old posts keep the value, and their version still has its label.
- Adding a required field doesn't invalidate old posts. They only have to supply it when edited, since an edit re-pins
  to the current version.
- Changing a key's type between versions is allowed. Filters on that key just don't match the older posts.
- Retiring a parent version creates new versions of all its children. Version numbers are per category and always
  increase in publish order.
