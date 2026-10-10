import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';

const DETAIL_ROW = z.object({
  category_slug: z.string(),
  category_name_bn: z.string().nullable(),
  category_name_en: z.string().nullable(),
  json_schema: z.unknown(),
  ui_schema: z.unknown(),
  price_type_code: z.string().nullable(),
  currency: z.string(),
  area_bn: z.string().nullable(),
  area_en: z.string().nullable(),
  distance_m: z.number().nullable(),
});
export type DetailRow = z.infer<typeof DETAIL_ROW>;

const SELLER_ROW = z.object({
  display_name: z.string().nullable(),
  member_since: z.coerce.date().nullable(),
  phone_verified: z.boolean().nullable(),
  trusted: z.boolean().nullable(),
  store_id: z.string().nullable(),
  store_slug: z.string().nullable(),
  store_name_bn: z.string().nullable(),
  store_name_en: z.string().nullable(),
  store_verified: z.boolean().nullable(),
  response_rate_pct: z.coerce.number().nullable(),
  median_response_seconds: z.number().nullable(),
});
export type SellerRow = z.infer<typeof SELLER_ROW>;

const COUNTS_ROW = z.object({
  views: z.number(),
  calls: z.number(),
  whatsapp: z.number(),
  sms: z.number(),
  saves: z.number(),
});
export type EngagementCounts = z.infer<typeof COUNTS_ROW>;

export interface NewLead {
  /** chat_started: the first seller reply in a chat (ADR 058), written by the chat module. */
  channel: 'call_click' | 'whatsapp_click' | 'sms_click' | 'chat_started';
  source: string;
  /** Null for a store's own contact (POST /stores/:id/contact). */
  postId: string | null;
  storeId: string | null;
  targetMemberId: string | null;
  actorMemberId: string | null;
  viewerKey: string;
}

/**
 * SQL for post detail, contacts, views, share links and reports (ADR 036).
 * Reads run in the post's OWNING tenant's context (PostOwnershipService), so
 * the ordinary policies decide what the caller sees; the 0031 functions
 * answer what those policies deliberately don't expose (seller card,
 * counters, reports across reporters).
 */
@Injectable()
export class EngagementRepository {
  async detail(
    tx: DatabaseTransaction,
    postId: string,
    viewer: { lat: number; lng: number } | null,
  ): Promise<DetailRow | undefined> {
    const distance = viewer
      ? sql`st_distance(p.location, public.geo_point(${viewer.lat}, ${viewer.lng}), false)`
      : sql`null::double precision`;
    const rows = await tx.execute(sql`
      select c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
             s.json_schema, s.ui_schema, p.price_type_code, p.currency::text as currency,
             coalesce(l.name_bn, ga.name_bn) as area_bn, coalesce(l.name_en, ga.name_en) as area_en,
             case when p.location is null then null else ${distance} end as distance_m
      from public.posts p
      join public.categories c on c.id = p.category_id
      left join public.category_field_schemas s on s.id = p.field_schema_id
      left join public.localities l on l.tenant_id = p.tenant_id and l.id = p.locality_id
      left join public.geo_areas ga on ga.id = p.geo_area_id
      where p.id = ${postId}::uuid`);
    return z
      .array(DETAIL_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** post_seller_card (0031): nothing for a post the caller may not see. */
  async sellerCard(
    tx: DatabaseTransaction,
    postId: string,
    trustedMin: number,
  ): Promise<SellerRow | undefined> {
    const rows = await tx.execute(sql`
      select display_name, member_since, phone_verified, trusted, store_id, store_slug,
             store_name_bn, store_name_en, store_verified, response_rate_pct, median_response_seconds
      from public.post_seller_card(${postId}::uuid, ${trustedMin}::smallint)`);
    return z
      .array(SELLER_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** Whether the caller saved this post (their own saved_posts rows are visible in any context). */
  async isSaved(tx: DatabaseTransaction, postId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select exists (
        select 1 from public.saved_posts
        where user_id = public.current_user_id() and post_id = ${postId}::uuid
      ) as saved`);
    return z
      .array(z.object({ saved: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!.saved;
  }

  /** post_engagement_counts (0031): only the author or staff get a row. */
  async counts(tx: DatabaseTransaction, postId: string): Promise<EngagementCounts | undefined> {
    const rows = await tx.execute(sql`
      select views, calls, whatsapp, sms, saves from public.post_engagement_counts(${postId}::uuid)`);
    return z
      .array(COUNTS_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async shortCodeOf(tx: DatabaseTransaction, postId: string): Promise<string | undefined> {
    const rows = await tx.execute(sql`
      select code from public.post_short_links where post_id = ${postId}::uuid`);
    return z
      .array(z.object({ code: z.string() }))
      .max(1)
      .parse([...rows])[0]?.code;
  }

  /**
   * Inserts the post's code; a concurrent insert for the same post, or a
   * code another post already has, inserts nothing (the caller re-reads).
   */
  async insertShortCode(tx: DatabaseTransaction, postId: string, code: string): Promise<void> {
    await tx.execute(sql`
      insert into public.post_short_links (post_id, code)
      values (${postId}::uuid, ${code})
      on conflict do nothing`);
  }

  async resolveShortCode(
    tx: DatabaseTransaction,
    code: string,
  ): Promise<{ tenantId: string; postId: string } | undefined> {
    const rows = await tx.execute(sql`
      select tenant_id, post_id from public.resolve_short_link(${code})`);
    const [row] = z
      .array(z.object({ tenant_id: z.string(), post_id: z.string() }))
      .max(1)
      .parse([...rows]);
    return row && { tenantId: row.tenant_id, postId: row.post_id };
  }

  async tenantSlug(tx: DatabaseTransaction, tenantId: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select slug from public.tenants where id = ${tenantId}::uuid`,
    );
    return z
      .array(z.object({ slug: z.string() }))
      .max(1)
      .parse([...rows])[0]?.slug;
  }

  /**
   * A catalog order's target (ADR 056): the host tenant's active store by
   * slug and its listed post, with the numbers to order on (WhatsApp, else
   * the store's phone). Nothing when either isn't public.
   */
  async catalogOrderTarget(
    tx: DatabaseTransaction,
    slug: string,
    postId: string,
  ): Promise<
    | {
        store_id: string;
        owner_member_id: string;
        number: string | null;
        title: string;
        tenant_id: string;
        out_of_stock: boolean;
      }
    | undefined
  > {
    const rows = await tx.execute(sql`
      select s.id as store_id, s.owner_member_id, coalesce(s.whatsapp_e164, s.phone_e164) as number,
             p.title, p.tenant_id, coalesce(p.stock_status_code = 'out_of_stock', false) as out_of_stock
      from public.stores s
      join public.posts p on p.tenant_id = s.tenant_id and p.store_id = s.id and p.id = ${postId}::uuid
      where s.tenant_id = public.current_tenant_id() and s.slug = ${slug}
        and s.status_code = 'active' and s.deleted_at is null
        and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())`);
    return z
      .array(
        z.object({
          store_id: z.string(),
          owner_member_id: z.string(),
          number: z.string().nullable(),
          title: z.string(),
          tenant_id: z.string(),
          out_of_stock: z.boolean(),
        }),
      )
      .max(1)
      .parse([...rows])[0];
  }

  /** The store's tenant (item_tenant_of, 0032). */
  async storeTenantOf(tx: DatabaseTransaction, storeId: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
    );
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
      undefined
    );
  }

  /** An active store's name, numbers and owner, under its public-read policy (ADR 054). */
  async storeContact(
    tx: DatabaseTransaction,
    storeId: string,
  ): Promise<
    | {
        name_bn: string;
        phone_e164: string | null;
        whatsapp_e164: string | null;
        owner_member_id: string;
      }
    | undefined
  > {
    const rows = await tx.execute(sql`
      select s.name_bn, s.phone_e164, s.whatsapp_e164, s.owner_member_id
      from public.stores s
      where s.id = ${storeId}::uuid and s.tenant_id = public.current_tenant_id()
        and s.status_code = 'active' and s.deleted_at is null`);
    return z
      .array(
        z.object({
          name_bn: z.string(),
          phone_e164: z.string().nullable(),
          whatsapp_e164: z.string().nullable(),
          owner_member_id: z.string(),
        }),
      )
      .max(1)
      .parse([...rows])[0];
  }

  /** One contact reveal (lead_events, 0009): billing evidence, so every field says who and where. */
  async insertLead(tx: DatabaseTransaction, lead: NewLead): Promise<void> {
    await tx.execute(sql`
      insert into public.lead_events
        (channel_code, source_code, post_id, store_id, target_member_id, actor_member_id, anon_session_hash)
      values
        (${lead.channel}, ${lead.source}, ${lead.postId}::uuid, ${lead.storeId}::uuid,
         ${lead.targetMemberId}::uuid, ${lead.actorMemberId}::uuid, ${lead.viewerKey})`);
  }

  /** report_post (0031): files the caller's report; may auto-hide the post. */
  async reportPost(
    tx: DatabaseTransaction,
    postId: string,
    reasonCode: string,
    details: string | null,
  ): Promise<{ reportId: string; created: boolean; reporterCount: number; autoHidden: boolean }> {
    const rows = await tx.execute(sql`
      select report_id, created, reporter_count, auto_hidden
      from public.report_post(${postId}::uuid, ${reasonCode}, ${details})`);
    const [row] = z
      .array(
        z.object({
          report_id: z.string(),
          created: z.boolean(),
          reporter_count: z.number(),
          auto_hidden: z.boolean(),
        }),
      )
      .length(1)
      .parse([...rows]);
    return {
      reportId: row!.report_id,
      created: row!.created,
      reporterCount: row!.reporter_count,
      autoHidden: row!.auto_hidden,
    };
  }

  /** add_post_views (0031), system context: returns the posts updated. */
  async addViews(
    tx: DatabaseTransaction,
    counts: ReadonlyArray<readonly [postId: string, count: number]>,
  ): Promise<number> {
    if (counts.length === 0) return 0;
    const ids = sql.join(
      counts.map(([id]) => sql`${id}::uuid`),
      sql`, `,
    );
    const values = sql.join(
      counts.map(([, n]) => sql`${n}::integer`),
      sql`, `,
    );
    const rows = await tx.execute(
      sql`select public.add_post_views(array[${ids}]::uuid[], array[${values}]::integer[]) as updated`,
    );
    return z
      .array(z.object({ updated: z.number() }))
      .length(1)
      .parse([...rows])[0]!.updated;
  }
}
