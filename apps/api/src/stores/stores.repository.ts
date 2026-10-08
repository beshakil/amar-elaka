import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { STORE_STATUSES } from './dto/stores.dto';

const nullableDate = z.coerce.date().nullable();
const numberOrNull = z.coerce.number().nullable();

const STORE_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  owner_member_id: z.string(),
  place_id: z.string().nullable(),
  slug: z.string(),
  previous_slug: z.string().nullable(),
  slug_changed_at: nullableDate,
  name_bn: z.string(),
  name_en: z.string().nullable(),
  description: z.string().nullable(),
  category_id: z.string().nullable(),
  category_slug: z.string().nullable(),
  category_name_bn: z.string().nullable(),
  category_name_en: z.string().nullable(),
  logo_media_id: z.string().nullable(),
  cover_media_id: z.string().nullable(),
  logo_variants: z.unknown(),
  logo_thumbhash: z.string().nullable(),
  cover_variants: z.unknown(),
  cover_thumbhash: z.string().nullable(),
  phone_e164: z.string().nullable(),
  whatsapp_e164: z.string().nullable(),
  address_text: z.string().nullable(),
  lat: numberOrNull,
  lng: numberOrNull,
  status_code: z.enum(STORE_STATUSES),
  tier_code: z.string(),
  is_verified: z.boolean(),
  my_role: z.enum(['owner', 'manager', 'editor']).nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type StoreRow = z.infer<typeof STORE_ROW>;

const PAGE_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  slug: z.string(),
  place_id: z.string().nullable(),
  name_bn: z.string(),
  name_en: z.string().nullable(),
  description: z.string().nullable(),
  category_id: z.string().nullable(),
  category_slug: z.string().nullable(),
  category_name_bn: z.string().nullable(),
  category_name_en: z.string().nullable(),
  address_text: z.string().nullable(),
  area_bn: z.string().nullable(),
  area_en: z.string().nullable(),
  lat: numberOrNull,
  lng: numberOrNull,
  pin_lat: numberOrNull,
  pin_lng: numberOrNull,
  logo_variants: z.unknown(),
  logo_thumbhash: z.string().nullable(),
  cover_variants: z.unknown(),
  cover_thumbhash: z.string().nullable(),
  is_verified: z.boolean(),
  seller_level: z.string().nullable(),
  rating: numberOrNull,
  rating_count: z.number(),
  follower_count: z.number(),
  live_posts: z.coerce.number(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type StorePageRow = z.infer<typeof PAGE_ROW>;

const STAFF_ROW = z.object({
  member_id: z.string(),
  role_code: z.string(),
  invited_at: z.coerce.date(),
  accepted_at: nullableDate,
  display_name: z.string().nullable(),
  phone_e164: z.string().nullable(),
});
export type StaffRow = z.infer<typeof STAFF_ROW>;

const MY_STORE_ROW = z.object({
  store_id: z.string(),
  tenant_id: z.string(),
  slug: z.string(),
  name_bn: z.string(),
  name_en: z.string().nullable(),
  status_code: z.enum(STORE_STATUSES),
  tier_code: z.string(),
  role_code: z.string(),
  accepted: z.boolean(),
  invited_at: nullableDate,
  logo_variants: z.unknown(),
  logo_thumbhash: z.string().nullable(),
});
export type MyStoreRow = z.infer<typeof MY_STORE_ROW>;

export interface NewStore {
  slug: string;
  nameBn: string;
  nameEn: string | null;
  nameTranslit: string | null;
  description: string | null;
  categoryId: string;
  logoMediaId: string | null;
  coverMediaId: string | null;
  phone: string | null;
  whatsapp: string | null;
  addressText: string | null;
  lat: number;
  lng: number;
  geoAreaId: string | null;
  outsideBoundary: boolean;
  placeSlug: string;
  live: boolean;
  maxPerOwner: number;
}

export interface StorePatch {
  slug?: string;
  nameBn?: string;
  nameEn?: string | null;
  nameTranslit?: string | null;
  description?: string | null;
  categoryId?: string;
  logoMediaId?: string | null;
  coverMediaId?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  addressText?: string | null;
  location?: { lat: number; lng: number };
}

/** The store's columns every reader needs, plus the caller's role on it. */
const STORE_SELECT = sql`
  s.id, s.tenant_id, s.owner_member_id, s.place_id, s.slug, s.previous_slug, s.slug_changed_at,
  s.name_bn, s.name_en, s.description, s.category_id,
  c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
  s.logo_media_id, s.cover_media_id,
  logo.variants as logo_variants, logo.thumbhash as logo_thumbhash,
  cover.variants as cover_variants, cover.thumbhash as cover_thumbhash,
  s.phone_e164, s.whatsapp_e164, s.address_text,
  st_y(s.location::geometry) as lat, st_x(s.location::geometry) as lng,
  s.status_code, s.tier_code, s.is_verified,
  case when s.owner_member_id = public.current_member_id() then 'owner' else sm.role_code end as my_role,
  s.created_at, s.updated_at`;

/** The store's logo and banner, when ready and public. */
const STORE_IMAGES = sql`
  left join public.categories c on c.id = s.category_id
  left join public.media_assets logo
    on logo.tenant_id = s.tenant_id and logo.id = s.logo_media_id
   and logo.status_code = 'ready' and logo.visibility_code = 'public' and logo.deleted_at is null
  left join public.media_assets cover
    on cover.tenant_id = s.tenant_id and cover.id = s.cover_media_id
   and cover.status_code = 'ready' and cover.visibility_code = 'public' and cover.deleted_at is null`;

/**
 * The stores module's reads and writes (ADR 054). Everything runs in the
 * store's tenant under the caller's RLS; the few writes RLS can't express
 * are SECURITY DEFINER functions (create_store, store_invite_staff, 0050).
 */
@Injectable()
export class StoresRepository {
  /** The store's tenant (item_tenant_of, 0032), or undefined when there's no such store. */
  async tenantOf(tx: DatabaseTransaction, storeId: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.item_tenant_of('store', ${storeId}::uuid) as tenant_id`,
    );
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
      undefined
    );
  }

  /**
   * The store as the caller's RLS shows it, with the caller's role (owner, or
   * accepted staff). `forUpdate` locks it — which RLS allows only its owner
   * and managers (and staff), so an editor gets no row back.
   */
  async find(
    tx: DatabaseTransaction,
    storeId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<StoreRow | undefined> {
    const rows = await tx.execute(sql`
      select ${STORE_SELECT}
      from public.stores s
      left join public.store_members sm
        on sm.tenant_id = s.tenant_id and sm.store_id = s.id
       and sm.member_id = public.current_member_id() and sm.accepted_at is not null
      ${STORE_IMAGES}
      where s.id = ${storeId}::uuid and s.tenant_id = public.current_tenant_id() and s.deleted_at is null
      ${options.forUpdate ? sql`for update of s` : sql``}`);
    return z
      .array(STORE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async create(
    tx: DatabaseTransaction,
    store: NewStore,
  ): Promise<{ storeId: string; placeId: string }> {
    const rows = await tx.execute(sql`
      select store_id, place_id from public.create_store(
        ${store.slug}, ${store.nameBn}, ${store.nameEn}, ${store.nameTranslit}, ${store.description},
        ${store.categoryId}::uuid, ${store.logoMediaId}::uuid, ${store.coverMediaId}::uuid,
        ${store.phone}, ${store.whatsapp}, ${store.addressText},
        ${store.lat}::float8, ${store.lng}::float8, ${store.geoAreaId}::uuid, ${store.outsideBoundary},
        ${store.placeSlug}, ${store.live}, ${store.maxPerOwner}::integer)`);
    const [row] = z
      .array(z.object({ store_id: z.string(), place_id: z.string() }))
      .length(1)
      .parse([...rows]);
    return { storeId: row!.store_id, placeId: row!.place_id };
  }

  /** Under RLS: owners and managers (and staff). False when nothing was updated. */
  async update(tx: DatabaseTransaction, storeId: string, patch: StorePatch): Promise<boolean> {
    const sets: SQL[] = [];
    if (patch.slug !== undefined) sets.push(sql`slug = ${patch.slug}`);
    if (patch.nameBn !== undefined) sets.push(sql`name_bn = ${patch.nameBn}`);
    if (patch.nameEn !== undefined) sets.push(sql`name_en = ${patch.nameEn}`);
    if (patch.nameTranslit !== undefined) sets.push(sql`name_translit = ${patch.nameTranslit}`);
    if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
    if (patch.categoryId !== undefined) sets.push(sql`category_id = ${patch.categoryId}::uuid`);
    if (patch.logoMediaId !== undefined) sets.push(sql`logo_media_id = ${patch.logoMediaId}::uuid`);
    if (patch.coverMediaId !== undefined)
      sets.push(sql`cover_media_id = ${patch.coverMediaId}::uuid`);
    if (patch.phone !== undefined) sets.push(sql`phone_e164 = ${patch.phone}`);
    if (patch.whatsapp !== undefined) sets.push(sql`whatsapp_e164 = ${patch.whatsapp}`);
    if (patch.addressText !== undefined) sets.push(sql`address_text = ${patch.addressText}`);
    if (patch.location !== undefined) {
      sets.push(sql`location = public.geo_point(${patch.location.lat}, ${patch.location.lng})`);
    }
    if (sets.length === 0) return true;
    const rows = await tx.execute(sql`
      update public.stores set ${sql.join(sets, sql`, `)}
      where id = ${storeId}::uuid and tenant_id = public.current_tenant_id() and deleted_at is null
      returning id`);
    return rows.length === 1;
  }

  /** store_slug_available (0050): no store here has it as its slug or its old one. */
  async slugAvailable(
    tx: DatabaseTransaction,
    slug: string,
    except: string | null,
  ): Promise<boolean> {
    const rows = await tx.execute(
      sql`select public.store_slug_available(${slug}, ${except}::uuid) as available`,
    );
    return z.array(z.object({ available: z.boolean() })).parse([...rows])[0]?.available ?? false;
  }

  /** A place category, active and enabled in this tenant: what a store (and its pin) may be. */
  async categoryUsable(tx: DatabaseTransaction, categoryId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select 1 from public.categories c
      join public.tenant_categories tc
        on tc.category_id = c.id and tc.tenant_id = public.current_tenant_id()
      where c.id = ${categoryId}::uuid and c.kind_code = 'place' and c.is_active and tc.is_enabled`);
    return rows.length > 0;
  }

  /** Attaches a new logo or banner to the store, so the orphan sweep keeps it (0019). */
  async attachMedia(
    tx: DatabaseTransaction,
    storeId: string,
    mediaIds: readonly string[],
  ): Promise<void> {
    for (const mediaId of mediaIds) {
      await tx.execute(sql`
        insert into public.media_attachments (media_asset_id, store_id, sort_order)
        values (${mediaId}::uuid, ${storeId}::uuid, 0)`);
    }
  }

  /** Detaches a replaced logo or banner the caller uploaded (RLS: uploader or staff). */
  async detachMedia(
    tx: DatabaseTransaction,
    storeId: string,
    mediaIds: readonly string[],
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    await tx.execute(sql`
      delete from public.media_attachments
      where store_id = ${storeId}::uuid
        and media_asset_id in (${sql.join(
          mediaIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
  }

  async staff(tx: DatabaseTransaction, storeId: string): Promise<StaffRow[]> {
    const rows = await tx.execute(sql`
      select member_id, role_code, invited_at, accepted_at, display_name, phone_e164
      from public.store_staff(${storeId}::uuid)`);
    return z.array(STAFF_ROW).parse([...rows]);
  }

  async inviteStaff(
    tx: DatabaseTransaction,
    storeId: string,
    phone: string,
    role: 'manager' | 'editor',
    maxStaff: number,
  ): Promise<{ memberId: string; userId: string }> {
    const rows = await tx.execute(sql`
      select member_id, user_id
      from public.store_invite_staff(${storeId}::uuid, ${phone}, ${role}, ${maxStaff}::integer)`);
    const [row] = z
      .array(z.object({ member_id: z.string(), user_id: z.string() }))
      .length(1)
      .parse([...rows]);
    return { memberId: row!.member_id, userId: row!.user_id };
  }

  /** The caller accepts their pending invitation (store_members_self_accept, 0006). */
  async acceptInvitation(tx: DatabaseTransaction, storeId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.store_members set accepted_at = now()
      where tenant_id = public.current_tenant_id() and store_id = ${storeId}::uuid
        and member_id = public.current_member_id() and accepted_at is null
      returning id`);
    return rows.length === 1;
  }

  /** Under RLS: managers remove staff, anyone removes themselves (store_members_self_delete). */
  async removeStaff(tx: DatabaseTransaction, storeId: string, memberId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      delete from public.store_members
      where tenant_id = public.current_tenant_id() and store_id = ${storeId}::uuid
        and member_id = ${memberId}::uuid
      returning id`);
    return rows.length === 1;
  }

  async myStores(tx: DatabaseTransaction): Promise<MyStoreRow[]> {
    const rows = await tx.execute(sql`
      select store_id, tenant_id, slug, name_bn, name_en, status_code, tier_code, role_code, accepted,
             invited_at, logo_variants, logo_thumbhash
      from public.my_stores()`);
    return z.array(MY_STORE_ROW).parse([...rows]);
  }

  // ---- moderation ------------------------------------------------------------

  /** Staff only (stores_manage_update, stores_protect_status). */
  async setStatus(tx: DatabaseTransaction, storeId: string, status: string): Promise<void> {
    await tx.execute(sql`
      update public.stores set status_code = ${status}
      where id = ${storeId}::uuid and tenant_id = public.current_tenant_id()`);
  }

  /** A store approved out of review: its pin, held with it, is published too. */
  async publishPin(tx: DatabaseTransaction, placeId: string): Promise<void> {
    await tx.execute(sql`
      update public.places set status_code = 'published'
      where id = ${placeId}::uuid and tenant_id = public.current_tenant_id()
        and status_code = 'pending_review'`);
  }

  async recordModeration(
    tx: DatabaseTransaction,
    action: {
      storeId: string;
      actionCode: string;
      reasonCode: string;
      reasonText: string | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.moderation_actions (store_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
      values (${action.storeId}::uuid, public.current_user_id(), ${action.actionCode}, ${action.reasonCode},
              ${action.reasonText}, '[]'::jsonb)`);
  }

  async reviewQueue(
    tx: DatabaseTransaction,
    before: string | null,
    limit: number,
  ): Promise<
    {
      id: string;
      slug: string;
      name_bn: string;
      name_en: string | null;
      category_id: string | null;
      category_slug: string | null;
      category_name_bn: string | null;
      category_name_en: string | null;
      lat: number | null;
      lng: number | null;
      owner_member_id: string;
      outside_boundary: boolean;
      created_at: Date;
    }[]
  > {
    const rows = await tx.execute(sql`
      select s.id, s.slug, s.name_bn, s.name_en, s.category_id,
             c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
             st_y(s.location::geometry) as lat, st_x(s.location::geometry) as lng,
             s.owner_member_id, coalesce(pl.outside_boundary, false) as outside_boundary, s.created_at
      from public.stores s
      left join public.categories c on c.id = s.category_id
      left join public.places pl on pl.tenant_id = s.tenant_id and pl.id = s.place_id
      where s.tenant_id = public.current_tenant_id() and s.status_code = 'pending_review'
        and s.deleted_at is null and (${before}::uuid is null or s.id > ${before}::uuid)
      order by s.id
      limit ${limit}`);
    return z
      .array(
        z.object({
          id: z.string(),
          slug: z.string(),
          name_bn: z.string(),
          name_en: z.string().nullable(),
          category_id: z.string().nullable(),
          category_slug: z.string().nullable(),
          category_name_bn: z.string().nullable(),
          category_name_en: z.string().nullable(),
          lat: numberOrNull,
          lng: numberOrNull,
          owner_member_id: z.string(),
          outside_boundary: z.boolean(),
          created_at: z.coerce.date(),
        }),
      )
      .parse([...rows]);
  }

  /** The owner of a store, as a user (for notifications). */
  async ownerUserId(tx: DatabaseTransaction, storeId: string): Promise<string | undefined> {
    const rows = await tx.execute(sql`
      select tm.user_id from public.stores s
      join public.tenant_members tm on tm.tenant_id = s.tenant_id and tm.id = s.owner_member_id
      where s.id = ${storeId}::uuid and s.tenant_id = public.current_tenant_id()`);
    return z.array(z.object({ user_id: z.string() })).parse([...rows])[0]?.user_id;
  }

  // ---- the public page --------------------------------------------------------

  /**
   * The host tenant's active store whose slug, or previous slug (an old
   * link), is `slug` — under the public-read policy. With the owner's seller
   * verification and the number of listed posts.
   */
  async page(tx: DatabaseTransaction, slug: string): Promise<StorePageRow | undefined> {
    const rows = await tx.execute(sql`
      select s.id, s.tenant_id, s.slug, s.place_id, s.name_bn, s.name_en, s.description, s.category_id,
             c.slug as category_slug, c.name_bn as category_name_bn, c.name_en as category_name_en,
             s.address_text,
             coalesce(l.name_bn, ga.name_bn) as area_bn, coalesce(l.name_en, ga.name_en) as area_en,
             st_y(coalesce(s.location, pl.location)::geometry) as lat,
             st_x(coalesce(s.location, pl.location)::geometry) as lng,
             st_y(pl.location::geometry) as pin_lat, st_x(pl.location::geometry) as pin_lng,
             logo.variants as logo_variants, logo.thumbhash as logo_thumbhash,
             cover.variants as cover_variants, cover.thumbhash as cover_thumbhash,
             s.is_verified, sp.verification_level_code as seller_level,
             s.rating_avg::float8 as rating, s.rating_count, s.follower_count,
             (select count(*) from public.posts p
              where p.tenant_id = s.tenant_id and p.store_id = s.id
                and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
             ) as live_posts,
             s.created_at, s.updated_at
      from public.stores s
      left join public.places pl on pl.tenant_id = s.tenant_id and pl.id = s.place_id
      left join public.localities l on l.tenant_id = s.tenant_id and l.id = coalesce(s.locality_id, pl.locality_id)
      left join public.geo_areas ga on ga.id = pl.geo_area_id
      left join public.seller_profiles sp on sp.tenant_id = s.tenant_id and sp.member_id = s.owner_member_id
      ${STORE_IMAGES}
      where s.tenant_id = public.current_tenant_id()
        and (s.slug = ${slug} or s.previous_slug = ${slug})
        and s.status_code = 'active' and s.deleted_at is null
      order by (s.slug = ${slug}) desc
      limit 1`);
    return z
      .array(PAGE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** The store's listed posts, newest first, keyset-paged by id, optionally in some categories. */
  async catalogRefs(
    tx: DatabaseTransaction,
    storeId: string,
    categoryIds: readonly string[] | null,
    before: string | null,
    limit: number,
  ): Promise<{ id: string; tenant_id: string }[]> {
    const inCategories =
      categoryIds === null
        ? sql`true`
        : sql`p.category_id = any(${`{${categoryIds.join(',')}}`}::uuid[])`;
    const rows = await tx.execute(sql`
      select p.id, p.tenant_id from public.posts p
      where p.tenant_id = public.current_tenant_id() and p.store_id = ${storeId}::uuid
        and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
        and ${inCategories}
        and (${before}::uuid is null or p.id < ${before}::uuid)
      order by p.id desc
      limit ${limit}`);
    return z.array(z.object({ id: z.string(), tenant_id: z.string() })).parse([...rows]);
  }

  /** The categories of the store's listed posts, most posts first: the catalog's filter chips. */
  async catalogCategories(
    tx: DatabaseTransaction,
    storeId: string,
  ): Promise<{ slug: string; name_bn: string; name_en: string | null; count: number }[]> {
    const rows = await tx.execute(sql`
      select c.slug, c.name_bn, c.name_en, count(*)::int as count
      from public.posts p
      join public.categories c on c.id = p.category_id
      where p.tenant_id = public.current_tenant_id() and p.store_id = ${storeId}::uuid
        and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())
      group by c.slug, c.name_bn, c.name_en
      order by count(*) desc, c.slug`);
    return z
      .array(
        z.object({
          slug: z.string(),
          name_bn: z.string(),
          name_en: z.string().nullable(),
          count: z.number(),
        }),
      )
      .parse([...rows]);
  }
}
