import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { POST_STATUSES, type PostStatus } from './post-state-machine';
import type { StockStatus } from './post-stock';

const nullableDate = z.coerce.date().nullable();

const POST_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  author_member_id: z.string().nullable(),
  store_id: z.string().nullable(),
  category_id: z.string(),
  field_schema_id: z.string(),
  field_schema_version: z.number().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  fields: z.record(z.unknown()),
  price: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  geo_area_id: z.string().nullable(),
  outside_boundary: z.boolean(),
  ownership_resolution_code: z.string(),
  show_phone: z.boolean(),
  allow_chat: z.boolean(),
  show_whatsapp: z.boolean(),
  contact_name: z.string().nullable(),
  contact_phone_e164: z.string().nullable(),
  status_code: z.enum(POST_STATUSES),
  sold_at: nullableDate,
  sold_price: z.string().nullable(),
  moderation_reason_code: z.string().nullable(),
  published_at: nullableDate,
  expires_at: nullableDate,
  bumped_at: nullableDate,
  hidden_by_owner: z.boolean(),
  stock_status_code: z.string().nullable(),
  scrubbed_at: nullableDate,
  deleted_at: nullableDate,
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type PostRow = z.infer<typeof POST_ROW>;

const POST_COLUMNS = sql`
  p.id, p.tenant_id, p.author_member_id, p.store_id, p.category_id, p.field_schema_id, s.version as field_schema_version,
  p.title, p.description, p.fields, p.price::text as price,
  st_y(p.location::geometry) as lat, st_x(p.location::geometry) as lng,
  p.geo_area_id, p.outside_boundary, p.ownership_resolution_code, p.show_phone, p.allow_chat,
  p.show_whatsapp, p.contact_name, p.contact_phone_e164,
  p.status_code, p.sold_at, p.sold_price::text as sold_price, p.moderation_reason_code,
  p.published_at, p.expires_at, p.bumped_at, p.hidden_by_owner, p.stock_status_code, p.scrubbed_at, p.deleted_at,
  p.created_at, p.updated_at`;

const MEDIA_ROW = z.object({
  post_id: z.string(),
  media_asset_id: z.string(),
  thumbhash: z.string().nullable(),
  variants: z.unknown(),
  status_code: z.string(),
  visibility_code: z.string(),
});
export type PostMediaRow = z.infer<typeof MEDIA_ROW>;

const CATEGORY_POLICY_ROW = z.object({
  category_expiry_days: z.number().nullable(),
  tenant_expiry_days: z.number().nullable(),
  category_mode: z.string().nullable(),
  tenant_mode: z.string().nullable(),
});

/** How a category behaves in the owning tenant (0017 expiry override, ADR 005 moderation). */
export interface CategoryPolicy {
  /** tenant_categories override, else the category default; null = the platform default setting. */
  expiryDays: number | null;
  /** The stricter of the category's (per-tenant) mode and the tenant's mode. */
  moderationMode: 'pre' | 'post';
}

export interface NewPost {
  categoryId: string;
  fieldSchemaId: string;
  title: string;
  description: string | null;
  fields: Record<string, unknown>;
  lat: number;
  lng: number;
  geoAreaId: string | null;
  ownershipResolution: string;
  outsideBoundary: boolean;
  showPhone: boolean | undefined;
  allowChat: boolean | undefined;
  showWhatsapp: boolean | undefined;
  contactName: string | null;
  contactPhone: string | null;
  /** Posted as this store (ADR 054); the author must be its owner or accepted staff. */
  storeId: string | null;
  status: PostStatus;
  publishedAt: Date | null;
  expiresAt: Date | null;
}

export type PostPatch = Partial<{
  categoryId: string;
  fieldSchemaId: string;
  title: string;
  description: string | null;
  fields: Record<string, unknown>;
  location: { lat: number; lng: number };
  geoAreaId: string | null;
  showPhone: boolean;
  allowChat: boolean;
  showWhatsapp: boolean;
  contactName: string;
  contactPhone: string;
  status: PostStatus;
  publishedAt: Date;
  expiresAt: Date;
  bumpedAt: Date;
  soldAt: Date;
  soldPrice: string | null;
  hiddenByOwner: boolean;
  stockStatus: StockStatus;
  deletedAt: Date;
  deletionReason: 'user_deleted';
  deletedByUserId: string;
}>;

/**
 * SQL for the posts module. Every method runs inside a transaction the
 * service opened in the post's OWNING tenant's context (PostOwnershipService),
 * so the ordinary RLS policies decide what is visible and writable.
 */
@Injectable()
export class PostsRepository {
  /** The caller owns or manages this store (can_manage_store, 0006): they run all of its posts. */
  async managesStore(tx: DatabaseTransaction, storeId: string): Promise<boolean> {
    const rows = await tx.execute(sql`select public.can_manage_store(${storeId}::uuid) as manages`);
    return z.array(z.object({ manages: z.boolean() })).parse([...rows])[0]?.manages ?? false;
  }

  /** Serialises one user's creates/submits, so two taps can't both pass a limit check. */
  async lockUser(tx: DatabaseTransaction, userId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`posts:${userId}`}, 0))`);
  }

  async myStats(
    tx: DatabaseTransaction,
    createdSince: Date,
  ): Promise<{ active: number; createdSince: number }> {
    const rows = await tx.execute(
      sql`select * from public.my_post_stats(${createdSince.toISOString()}::timestamptz)`,
    );
    const [row] = z
      .array(z.object({ active_count: z.number(), created_since_count: z.number() }))
      .length(1)
      .parse([...rows]);
    return { active: row!.active_count, createdSince: row!.created_since_count };
  }

  async resolveOwner(
    tx: DatabaseTransaction,
    lat: number,
    lng: number,
    fallbackTenantId: string,
  ): Promise<{ tenantId: string; resolution: string }> {
    const rows = await tx.execute(sql`
      select tenant_id, resolution_code
      from public.resolve_owning_tenant(public.geo_point(${lat}, ${lng}), ${fallbackTenantId}::uuid)`);
    const [row] = z
      .array(z.object({ tenant_id: z.string(), resolution_code: z.string() }))
      .length(1)
      .parse([...rows]);
    return { tenantId: row!.tenant_id, resolution: row!.resolution_code };
  }

  async ensureMembership(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<{ memberId: string; roleCode: string }> {
    const rows = await tx.execute(
      sql`select * from public.ensure_my_membership(${tenantId}::uuid)`,
    );
    const [row] = z
      .array(z.object({ member_id: z.string(), role_code: z.string() }))
      .length(1)
      .parse([...rows]);
    return { memberId: row!.member_id, roleCode: row!.role_code };
  }

  async membershipIn(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<{ memberId: string; roleCode: string } | undefined> {
    const rows = await tx.execute(sql`select * from public.my_membership_in(${tenantId}::uuid)`);
    const [row] = z
      .array(z.object({ member_id: z.string(), role_code: z.string() }))
      .max(1)
      .parse([...rows]);
    return row && { memberId: row.member_id, roleCode: row.role_code };
  }

  async tenantOf(tx: DatabaseTransaction, postId: string): Promise<string | undefined> {
    const rows = await tx.execute(sql`select public.post_tenant_of(${postId}::uuid) as tenant_id`);
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
      undefined
    );
  }

  async myPostRefs(
    tx: DatabaseTransaction,
    filter: { statuses: readonly PostStatus[] | null; hidden: boolean | null },
    before: string | null,
    limit: number,
  ): Promise<{ id: string; tenantId: string }[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id from public.my_post_refs(
        ${
          filter.statuses === null
            ? null
            : sql`array[${sql.join(
                filter.statuses.map((s) => sql`${s}`),
                sql`, `,
              )}]::text[]`
        },
        ${filter.hidden}::boolean, ${before}::uuid, ${limit})`);
    return z
      .array(z.object({ id: z.string(), tenant_id: z.string() }))
      .parse([...rows])
      .map((r) => ({ id: r.id, tenantId: r.tenant_id }));
  }

  /** The caller's posts per "my posts" tab (my_post_counts, 0029); missing buckets are 0. */
  async myPostCounts(tx: DatabaseTransaction): Promise<Map<string, number>> {
    const rows = await tx.execute(sql`select bucket, post_count from public.my_post_counts()`);
    return new Map(
      z
        .array(z.object({ bucket: z.string(), post_count: z.number() }))
        .parse([...rows])
        .map((r) => [r.bucket, r.post_count]),
    );
  }

  /** The author's own profile name and phone: a new post's default contact. */
  async myContactDefaults(
    tx: DatabaseTransaction,
  ): Promise<{ name: string | null; phone: string | null }> {
    const rows = await tx.execute(sql`
      select up.display_name, u.phone_e164
      from public.users u
      left join public.user_profiles up on up.user_id = u.id
      where u.id = public.current_user_id()`);
    const [row] = z
      .array(z.object({ display_name: z.string().nullable(), phone_e164: z.string().nullable() }))
      .max(1)
      .parse([...rows]);
    return { name: row?.display_name?.trim() || null, phone: row?.phone_e164 ?? null };
  }

  /**
   * The moderator's note on the post's latest rejection or removal, as its
   * author may read it (my_post_moderation_history, 0010/0029). Needs the
   * author's own member context in the post's tenant.
   */
  async moderationNote(tx: DatabaseTransaction, postId: string): Promise<string | null> {
    const rows = await tx.execute(sql`
      select reason_text from public.my_post_moderation_history(${postId}::uuid)
      where action_code in ('rejected', 'removed')
      order by created_at desc
      limit 1`);
    const [row] = z
      .array(z.object({ reason_text: z.string().nullable() }))
      .max(1)
      .parse([...rows]);
    return row?.reason_text ?? null;
  }

  async categoryPolicy(
    tx: DatabaseTransaction,
    categoryId: string,
    tenantId: string,
  ): Promise<CategoryPolicy> {
    const rows = await tx.execute(sql`
      select c.default_post_expiry_days as category_expiry_days,
             tc.post_expiry_days as tenant_expiry_days,
             coalesce(tc.moderation_mode_code, c.default_moderation_mode_code) as category_mode,
             ts.post_moderation_mode_code as tenant_mode
      from public.categories c
      left join public.tenant_categories tc on tc.category_id = c.id and tc.tenant_id = ${tenantId}::uuid
      left join public.tenant_settings ts on ts.tenant_id = ${tenantId}::uuid
      where c.id = ${categoryId}::uuid`);
    const [row] = z
      .array(CATEGORY_POLICY_ROW)
      .length(1)
      .parse([...rows]);
    return {
      expiryDays: row!.tenant_expiry_days ?? row!.category_expiry_days,
      moderationMode: row!.category_mode === 'pre' || row!.tenant_mode === 'pre' ? 'pre' : 'post',
    };
  }

  async findById(
    tx: DatabaseTransaction,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<PostRow | undefined> {
    const rows = await tx.execute(sql`
      select ${POST_COLUMNS}
      from public.posts p
      left join public.category_field_schemas s on s.id = p.field_schema_id
      where p.id = ${id}::uuid
      ${options.forUpdate ? sql`for update of p` : sql``}`);
    return z
      .array(POST_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async findByIds(tx: DatabaseTransaction, ids: readonly string[]): Promise<PostRow[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute(sql`
      select ${POST_COLUMNS}
      from public.posts p
      left join public.category_field_schemas s on s.id = p.field_schema_id
      where p.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
    return z.array(POST_ROW).parse([...rows]);
  }

  async insert(tx: DatabaseTransaction, memberId: string, post: NewPost): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.posts
        (author_member_id, store_id, category_id, field_schema_id, title, description, fields,
         location, location_is_approximate, geo_area_id, ownership_resolution_code, outside_boundary,
         show_phone, allow_chat, show_whatsapp, contact_name, contact_phone_e164,
         status_code, published_at, expires_at, bumped_at)
      values
        (${memberId}::uuid, ${post.storeId}::uuid, ${post.categoryId}::uuid, ${post.fieldSchemaId}::uuid, ${post.title},
         ${post.description}, ${JSON.stringify(post.fields)}::jsonb,
         public.geo_point(${post.lat}, ${post.lng}), false, ${post.geoAreaId}::uuid,
         ${post.ownershipResolution}, ${post.outsideBoundary},
         ${post.showPhone ?? true}, ${post.allowChat ?? true}, ${post.showWhatsapp ?? false},
         ${post.contactName}, ${post.contactPhone}, ${post.status},
         ${post.publishedAt?.toISOString() ?? null}::timestamptz,
         ${post.expiresAt?.toISOString() ?? null}::timestamptz,
         ${post.publishedAt?.toISOString() ?? null}::timestamptz)
      returning id`);
    return z
      .array(z.object({ id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.id;
  }

  /**
   * What posting as a store needs (store_posting_facts, 0050): its tenant,
   * status, tier, how many posts it holds and whether the caller may post as
   * it (member_may_post_as_store — the same rule as the posts trigger).
   */
  async storePostingFacts(
    tx: DatabaseTransaction,
    storeId: string,
  ): Promise<
    | { tenantId: string; status: string; tier: string; catalogCount: number; mayPost: boolean }
    | undefined
  > {
    const rows = await tx.execute(sql`
      select tenant_id, status_code, tier_code, catalog_count, may_post
      from public.store_posting_facts(${storeId}::uuid)`);
    const row = z
      .array(
        z.object({
          tenant_id: z.string(),
          status_code: z.string(),
          tier_code: z.string(),
          catalog_count: z.number(),
          may_post: z.boolean(),
        }),
      )
      .max(1)
      .parse([...rows])[0];
    return row
      ? {
          tenantId: row.tenant_id,
          status: row.status_code,
          tier: row.tier_code,
          catalogCount: row.catalog_count,
          mayPost: row.may_post,
        }
      : undefined;
  }

  async update(tx: DatabaseTransaction, id: string, patch: PostPatch): Promise<void> {
    const sets: SQL[] = [];
    const set = (column: string, value: SQL) => sets.push(sql`${sql.raw(column)} = ${value}`);
    const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
    if (patch.categoryId !== undefined) set('category_id', sql`${patch.categoryId}::uuid`);
    if (patch.fieldSchemaId !== undefined)
      set('field_schema_id', sql`${patch.fieldSchemaId}::uuid`);
    if (patch.title !== undefined) set('title', sql`${patch.title}`);
    if (patch.description !== undefined) set('description', sql`${patch.description}`);
    if (patch.fields !== undefined) set('fields', sql`${JSON.stringify(patch.fields)}::jsonb`);
    if (patch.location !== undefined) {
      set('location', sql`public.geo_point(${patch.location.lat}, ${patch.location.lng})`);
    }
    if (patch.geoAreaId !== undefined) set('geo_area_id', sql`${patch.geoAreaId}::uuid`);
    if (patch.showPhone !== undefined) set('show_phone', sql`${patch.showPhone}`);
    if (patch.allowChat !== undefined) set('allow_chat', sql`${patch.allowChat}`);
    if (patch.showWhatsapp !== undefined) set('show_whatsapp', sql`${patch.showWhatsapp}`);
    if (patch.contactName !== undefined) set('contact_name', sql`${patch.contactName}`);
    if (patch.contactPhone !== undefined) set('contact_phone_e164', sql`${patch.contactPhone}`);
    if (patch.status !== undefined) set('status_code', sql`${patch.status}`);
    if (patch.publishedAt !== undefined) set('published_at', iso(patch.publishedAt));
    if (patch.expiresAt !== undefined) set('expires_at', iso(patch.expiresAt));
    if (patch.bumpedAt !== undefined) set('bumped_at', iso(patch.bumpedAt));
    if (patch.soldAt !== undefined) set('sold_at', iso(patch.soldAt));
    if (patch.soldPrice !== undefined) set('sold_price', sql`${patch.soldPrice}::numeric(12,2)`);
    if (patch.hiddenByOwner !== undefined) set('hidden_by_owner', sql`${patch.hiddenByOwner}`);
    if (patch.stockStatus !== undefined) set('stock_status_code', sql`${patch.stockStatus}`);
    if (patch.deletedAt !== undefined) set('deleted_at', iso(patch.deletedAt));
    if (patch.deletionReason !== undefined)
      set('deletion_reason_code', sql`${patch.deletionReason}`);
    if (patch.deletedByUserId !== undefined) {
      set('deleted_by_user_id', sql`${patch.deletedByUserId}::uuid`);
    }
    if (sets.length === 0) return;
    await tx.execute(
      sql`update public.posts set ${sql.join(sets, sql`, `)} where id = ${id}::uuid`,
    );
  }

  /** The caller's own images among `ids` that are ready, live and not attached to another post. */
  async usableMedia(
    tx: DatabaseTransaction,
    ids: readonly string[],
    userId: string,
    postId: string | null,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute(sql`
      select m.id from public.media_assets m
      where m.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        and m.uploaded_by_user_id = ${userId}::uuid
        and m.kind_code = 'image'
        and m.status_code = 'ready'
        and m.deleted_at is null
        and not exists (
          select 1 from public.media_attachments a
          where a.media_asset_id = m.id
            and (a.post_id is null or a.post_id is distinct from ${postId}::uuid)
        )`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  async replaceMedia(
    tx: DatabaseTransaction,
    postId: string,
    mediaIds: readonly string[],
  ): Promise<void> {
    await tx.execute(sql`delete from public.media_attachments where post_id = ${postId}::uuid`);
    for (const [index, mediaId] of mediaIds.entries()) {
      await tx.execute(sql`
        insert into public.media_attachments (media_asset_id, post_id, sort_order)
        values (${mediaId}::uuid, ${postId}::uuid, ${index})`);
    }
  }

  async mediaOf(tx: DatabaseTransaction, postIds: readonly string[]): Promise<PostMediaRow[]> {
    if (postIds.length === 0) return [];
    const rows = await tx.execute(sql`
      select a.post_id, a.media_asset_id, m.thumbhash, m.variants, m.status_code, m.visibility_code
      from public.media_attachments a
      join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
      where a.post_id in (${sql.join(
        postIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      order by a.post_id, a.sort_order`);
    return z.array(MEDIA_ROW).parse([...rows]);
  }

  async mediaIdsOf(tx: DatabaseTransaction, postId: string): Promise<string[]> {
    const rows = await tx.execute(sql`
      select media_asset_id from public.media_attachments
      where post_id = ${postId}::uuid order by sort_order`);
    return z
      .array(z.object({ media_asset_id: z.string() }))
      .parse([...rows])
      .map((r) => r.media_asset_id);
  }

  /** A post.* domain event in the caller's transaction (transactional outbox, 0012). */
  async emit(
    tx: DatabaseTransaction,
    eventType: `post.${string}`,
    postId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.outbox_events (aggregate_table, aggregate_id, event_type, payload)
      values ('posts', ${postId}::uuid, ${eventType}, ${JSON.stringify(payload)}::jsonb)`);
  }

  /**
   * The expiry sweep (system context): live posts past `expires_at`, one
   * batch at a time, locked so parallel workers never expire the same row.
   */
  async expireDue(
    tx: DatabaseTransaction,
    batch: number,
  ): Promise<{ id: string; tenantId: string }[]> {
    const rows = await tx.execute(sql`
      with due as (
        select id from public.posts
        where status_code = 'live' and expires_at <= now() and deleted_at is null
        order by expires_at
        limit ${batch}
        for update skip locked
      )
      update public.posts p set status_code = 'expired'
      from due where p.id = due.id
      returning p.id, p.tenant_id`);
    return z
      .array(z.object({ id: z.string(), tenant_id: z.string() }))
      .parse([...rows])
      .map((r) => ({ id: r.id, tenantId: r.tenant_id }));
  }
}
