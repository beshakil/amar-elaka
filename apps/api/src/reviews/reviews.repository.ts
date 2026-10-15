import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { ELIGIBILITY_STATUSES, REVIEW_FLAGS, REVIEW_STATUSES } from './dto/reviews.dto';

const timestamp = z.union([z.date(), z.string()]).transform((v) => new Date(v).toISOString());
const optionalTimestamp = timestamp.nullable();
const count = z.union([z.number(), z.string(), z.bigint()]).transform((v) => Number(v));
const photoRow = z.object({
  id: z.string(),
  thumbhash: z.string().nullable(),
  variants: z.unknown(),
});
export type PhotoRow = z.infer<typeof photoRow>;

const ELIGIBILITY_ROW = z.object({
  status: z.enum(ELIGIBILITY_STATUSES),
  lead_event_id: z.string().nullable(),
  eligible_at: optionalTimestamp,
  expires_at: optionalTimestamp,
  review_id: z.string().nullable(),
});
export type EligibilityRow = z.infer<typeof ELIGIBILITY_ROW>;

const WRITE_ROW = z.object({
  review_id: z.string(),
  status_code: z.enum(REVIEW_STATUSES),
  flags: z.array(z.enum(REVIEW_FLAGS)),
});
export type WriteRow = z.infer<typeof WRITE_ROW>;

const PAGE_ROW = z.object({
  review_id: z.string(),
  rating: z.number(),
  body: z.string().nullable(),
  author_name: z.string().nullable(),
  author_scrubbed: z.boolean(),
  created_at: timestamp,
  edited_at: optionalTimestamp,
  response_body: z.string().nullable(),
  response_at: optionalTimestamp,
  response_edited_at: optionalTimestamp,
  photos: z.array(photoRow),
});
export type ReviewPageRow = z.infer<typeof PAGE_ROW>;

const MINE_ROW = z.object({
  review_id: z.string(),
  rating: z.number(),
  body: z.string().nullable(),
  status_code: z.enum(REVIEW_STATUSES),
  created_at: timestamp,
  edited_at: optionalTimestamp,
  editable_until: timestamp,
  photos: z.array(photoRow),
});
export type MyReviewRow = z.infer<typeof MINE_ROW>;

const QUEUE_ROW = z.object({
  review_id: z.string(),
  store_id: z.string(),
  store_name: z.string(),
  rating: z.number(),
  body: z.string().nullable(),
  status_code: z.enum(REVIEW_STATUSES),
  flags: z.array(z.enum(REVIEW_FLAGS)),
  open_reports: count,
  report_reasons: z.array(z.string()).nullable(),
  author_name: z.string().nullable(),
  created_at: timestamp,
});
export type ReviewQueueRow = z.infer<typeof QUEUE_ROW>;

const SCORE_INPUTS_ROW = z.object({
  rating_sum: count,
  rating_count: count,
  conversations: count,
  answered: count,
  median_reply_seconds: z.number().nullable(),
  store_created_at: z.coerce.date(),
  verification_level: z.string(),
  upheld_reports: count,
});
export type SellerScoreInputsRow = z.infer<typeof SCORE_INPUTS_ROW>;

const SCORE_ROW = z.object({
  score: z.number(),
  tier_code: z.string(),
  stale: z.boolean(),
});

const PROMPT_ROW = z.object({
  tenant_id: z.string(),
  store_id: z.string(),
  user_id: z.string(),
  store_name: z.string(),
  lead_event_id: z.string().nullable(),
});
export type DuePromptRow = z.infer<typeof PROMPT_ROW>;

const uuids = (ids: readonly string[]) =>
  ids.length === 0
    ? sql`'{}'::uuid[]`
    : sql`array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[]`;

/**
 * Reviews' SQL (ADR 061). Every rule lives in the 0057 functions —
 * eligibility, integrity, the one-review rule, audit — so this file only
 * calls them and parses what comes back.
 */
@Injectable()
export class ReviewsRepository {
  /** item_tenant_of (0050): the store's own tenant, or null. */
  async storeTenantOf(tx: DatabaseTransaction, storeId: string): Promise<string | null> {
    const rows = await tx.execute(
      sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
    );
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ?? null
    );
  }

  async eligibility(tx: DatabaseTransaction, storeId: string): Promise<EligibilityRow> {
    const rows = await tx.execute(sql`
      select status, lead_event_id, eligible_at, expires_at, review_id
      from public.review_eligibility(${storeId}::uuid)`);
    return z
      .array(ELIGIBILITY_ROW)
      .length(1)
      .parse([...rows])[0]!;
  }

  async submit(
    tx: DatabaseTransaction,
    input: {
      storeId: string;
      rating: number;
      text: string | null;
      photoIds: readonly string[];
      trust: number;
    },
  ): Promise<WriteRow> {
    const rows = await tx.execute(sql`
      select review_id, status_code, flags
      from public.submit_review(${input.storeId}::uuid, ${input.rating}::smallint, ${input.text},
                                ${uuids(input.photoIds)}, ${input.trust}::integer)`);
    return z
      .array(WRITE_ROW)
      .length(1)
      .parse([...rows])[0]!;
  }

  async edit(
    tx: DatabaseTransaction,
    input: {
      reviewId: string;
      rating: number;
      text: string | null;
      photoIds: readonly string[];
      trust: number;
    },
  ): Promise<WriteRow> {
    const rows = await tx.execute(sql`
      select review_id, status_code, flags
      from public.edit_review(${input.reviewId}::uuid, ${input.rating}::smallint, ${input.text},
                              ${uuids(input.photoIds)}, ${input.trust}::integer)`);
    return z
      .array(WRITE_ROW)
      .length(1)
      .parse([...rows])[0]!;
  }

  async mine(tx: DatabaseTransaction, storeId: string): Promise<MyReviewRow | undefined> {
    const rows = await tx.execute(sql`
      select review_id, rating, body, status_code, created_at, edited_at, editable_until, photos
      from public.my_store_review(${storeId}::uuid)`);
    return z
      .array(MINE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async page(
    tx: DatabaseTransaction,
    storeId: string,
    before: string | undefined,
    limit: number,
  ): Promise<ReviewPageRow[]> {
    const rows = await tx.execute(sql`
      select review_id, rating, body, author_name, author_scrubbed, created_at, edited_at,
             response_body, response_at, response_edited_at, photos
      from public.store_review_page(${storeId}::uuid, ${before ?? null}::uuid, ${limit}::integer)`);
    return z.array(PAGE_ROW).parse([...rows]);
  }

  async histogram(tx: DatabaseTransaction, storeId: string): Promise<Map<number, number>> {
    const rows = await tx.execute(sql`
      select rating, n from public.store_rating_summary(${storeId}::uuid)`);
    return new Map(
      z
        .array(z.object({ rating: z.number(), n: count }))
        .parse([...rows])
        .map((r) => [r.rating, r.n]),
    );
  }

  async respond(tx: DatabaseTransaction, reviewId: string, text: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select created from public.respond_to_review(${reviewId}::uuid, ${text})`);
    return z
      .array(z.object({ created: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!.created;
  }

  async report(
    tx: DatabaseTransaction,
    reviewId: string,
    reasonCode: string,
    details: string | null,
  ): Promise<{ reportId: string; created: boolean }> {
    const rows = await tx.execute(sql`
      select report_id, created from public.report_review(${reviewId}::uuid, ${reasonCode}, ${details})`);
    const row = z
      .array(z.object({ report_id: z.string(), created: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!;
    return { reportId: row.report_id, created: row.created };
  }

  async queue(
    tx: DatabaseTransaction,
    after: string | undefined,
    limit: number,
  ): Promise<ReviewQueueRow[]> {
    const rows = await tx.execute(sql`
      select review_id, store_id, store_name, rating, body, status_code, flags, open_reports,
             report_reasons, author_name, created_at
      from public.review_queue_page(${after ?? null}::uuid, ${limit}::integer)`);
    return z.array(QUEUE_ROW).parse([...rows]);
  }

  async decide(
    tx: DatabaseTransaction,
    input: { reviewId: string; decision: string; reasonCode: string; note: string | null },
  ): Promise<{ status: (typeof REVIEW_STATUSES)[number]; reportsClosed: number }> {
    const rows = await tx.execute(sql`
      select status_code, reports_closed
      from public.decide_review(${input.reviewId}::uuid, ${input.decision}, ${input.reasonCode}, ${input.note})`);
    const row = z
      .array(z.object({ status_code: z.enum(REVIEW_STATUSES), reports_closed: count }))
      .length(1)
      .parse([...rows])[0]!;
    return { status: row.status_code, reportsClosed: row.reports_closed };
  }

  /** The author and store of a review, for telling the author about a decision. */
  async authorOf(
    tx: DatabaseTransaction,
    reviewId: string,
  ): Promise<{ userId: string; storeId: string | null; storeName: string | null } | undefined> {
    const rows = await tx.execute(sql`
      select tm.user_id, r.store_id, s.name_bn as store_name
      from public.reviews r
      join public.tenant_members tm on tm.tenant_id = r.tenant_id and tm.id = r.reviewer_member_id
      left join public.stores s on s.tenant_id = r.tenant_id and s.id = r.store_id
      where r.id = ${reviewId}::uuid`);
    const row = z
      .array(
        z.object({
          user_id: z.string(),
          store_id: z.string().nullable(),
          store_name: z.string().nullable(),
        }),
      )
      .max(1)
      .parse([...rows])[0];
    return row && { userId: row.user_id, storeId: row.store_id, storeName: row.store_name };
  }

  async scrubAuthor(tx: DatabaseTransaction, userId: string, reason: string): Promise<number> {
    const rows = await tx.execute(
      sql`select public.scrub_review_author(${userId}::uuid, ${reason}) as n`,
    );
    return z
      .array(z.object({ n: z.number() }))
      .length(1)
      .parse([...rows])[0]!.n;
  }

  async duePrompts(tx: DatabaseTransaction, limit: number): Promise<DuePromptRow[]> {
    const rows = await tx.execute(sql`
      select tenant_id, store_id, user_id, store_name, lead_event_id
      from public.due_review_prompts(${limit}::integer)`);
    return z.array(PROMPT_ROW).parse([...rows]);
  }

  /** The caller's own image upload's status in this tenant (review photos are plain `image`s). */
  async ownImageStatus(
    tx: DatabaseTransaction,
    mediaId: string,
    userId: string,
  ): Promise<string | null> {
    const rows = await tx.execute(sql`
      select status_code from public.media_assets
      where id = ${mediaId}::uuid and uploaded_by_user_id = ${userId}::uuid and kind_code = 'image'
        and deleted_at is null`);
    return z.array(z.object({ status_code: z.string() })).parse([...rows])[0]?.status_code ?? null;
  }

  // ---- seller score ---------------------------------------------------------

  async scoreInputs(
    tx: DatabaseTransaction,
    storeId: string,
  ): Promise<SellerScoreInputsRow | undefined> {
    const rows = await tx.execute(sql`
      select rating_sum, rating_count, conversations, answered, median_reply_seconds,
             store_created_at, verification_level, upheld_reports
      from public.store_seller_score_inputs(${storeId}::uuid)`);
    return z
      .array(SCORE_INPUTS_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async cachedScores(
    tx: DatabaseTransaction,
    storeIds: readonly string[],
  ): Promise<Map<string, z.infer<typeof SCORE_ROW>>> {
    if (storeIds.length === 0) return new Map();
    const rows = await tx.execute(sql`
      select store_id, score, tier_code,
             (next_recompute_at is not null and next_recompute_at <= now()) as stale
      from public.store_seller_scores
      where store_id = any(${uuids(storeIds)})`);
    return new Map(
      z
        .array(SCORE_ROW.extend({ store_id: z.string() }))
        .parse([...rows])
        .map((r) => [r.store_id, r]),
    );
  }

  async saveScore(
    tx: DatabaseTransaction,
    input: {
      storeId: string;
      score: number;
      tier: string;
      components: Record<string, number>;
      algorithmVersion: number;
      cacheHours: number;
    },
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.store_seller_scores
        (store_id, score, tier_code, components, algorithm_version, computed_at, next_recompute_at)
      values
        (${input.storeId}::uuid, ${input.score}::smallint, ${input.tier}, ${JSON.stringify(input.components)}::jsonb,
         ${input.algorithmVersion}::smallint, now(), now() + make_interval(hours => ${input.cacheHours}::integer))
      on conflict (tenant_id, store_id) do update set
        score = excluded.score,
        tier_code = excluded.tier_code,
        components = excluded.components,
        algorithm_version = excluded.algorithm_version,
        computed_at = excluded.computed_at,
        next_recompute_at = excluded.next_recompute_at`);
  }
}
