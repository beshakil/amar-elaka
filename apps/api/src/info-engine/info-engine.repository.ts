import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type {
  GovServiceInput,
  LostFoundInput,
  NoticeInput,
  OutageInput,
  RouteInput,
} from './dto/info-engine.dto';
import { normalizeMoney } from './info-engine.rules';

/**
 * The info engine's reads and writes (ADR 065). Lists are radius-based
 * across areas through the SECURITY DEFINER readers of 0061 (rule 10); a
 * single item and every write run in the item's own area under its RLS.
 * No SELECT *, every row parsed with zod.
 */

export interface Origin {
  lat: number;
  lng: number;
}

function point(p: Origin): SQL {
  return sql`st_setsrid(st_makepoint(${p.lng}, ${p.lat}), 4326)::geography`;
}
const pointOrNull = (p: Origin | null | undefined): SQL => (p ? point(p) : sql`null::geography`);
function textArray(values: readonly string[] | null): SQL {
  return values === null ? sql`null::text[]` : sql`${`{${values.join(',')}}`}::text[]`;
}
function uuidArray(values: readonly string[]): SQL {
  return sql`${`{${values.join(',')}}`}::uuid[]`;
}
function smallintArray(values: readonly number[]): SQL {
  return sql`${`{${values.join(',')}}`}::smallint[]`;
}

const date = z.coerce.date();
const nText = z.string().nullable();
const nNumber = z.number().nullable();
const one = <T extends z.ZodTypeAny>(schema: T, rows: Iterable<unknown>): z.infer<T> | undefined =>
  z.array(schema).parse([...rows])[0];
const idRow = z.object({ id: z.string() });

// ---- row shapes ---------------------------------------------------------------

const outageRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  utility_code: z.string(),
  area_bn: nText,
  area_en: nText,
  area_text: nText,
  starts_at: date,
  ends_at: date,
  reason_text: nText,
  updated_at: date,
  distance_m: nNumber,
});
export type OutageRow = z.infer<typeof outageRow>;

const clusterRow = z.object({
  tenant_id: z.string(),
  utility_code: z.string(),
  locality_id: nText,
  area_bn: nText,
  area_en: nText,
  reporters: z.number(),
  first_at: date,
  last_at: date,
  distance_m: nNumber,
});
export type ClusterRow = z.infer<typeof clusterRow>;

const outageAdminRow = z.object({
  id: z.string(),
  utility_code: z.string(),
  locality_id: nText,
  area_text: nText,
  starts_at: date,
  ends_at: date,
  reason_text: nText,
  status_code: z.string(),
});
export type OutageAdminRow = z.infer<typeof outageAdminRow>;

const noticeRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  notice_type_code: z.string(),
  category_code: z.string(),
  title: z.string(),
  body: z.string(),
  issuer_name: nText,
  is_official: z.boolean(),
  is_pinned: z.boolean(),
  template_code: nText,
  template_fields: z.record(z.unknown()),
  event_starts_at: date.nullable(),
  event_ends_at: date.nullable(),
  valid_from: date.nullable(),
  expires_at: date.nullable(),
  published_at: date.nullable(),
  updated_at: date,
  area_bn: nText,
  distance_m: nNumber,
  attachments: z.number(),
});
export type NoticeRow = z.infer<typeof noticeRow>;

const noticeDetailRow = noticeRow.extend({
  status_code: z.string(),
  published_by_member_id: z.string(),
});
export type NoticeDetailRow = z.infer<typeof noticeDetailRow>;

const attachmentRow = z.object({
  id: z.string(),
  kind_code: z.string(),
  mime_type: z.string(),
  storage_key: z.string(),
  variants: z.unknown(),
  thumbhash: nText,
});
export type AttachmentRow = z.infer<typeof attachmentRow>;

const lostFoundRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  kind_code: z.string(),
  item_type_code: z.string(),
  title: z.string(),
  description: nText,
  location_text: nText,
  last_seen_at: date.nullable(),
  occurred_on: nText,
  reward_amount: nText,
  updated_at: date,
  created_at: date,
  lat: nNumber,
  lng: nNumber,
  distance_m: nNumber,
  photo_variants: z.unknown(),
  photo_thumbhash: nText,
});
export type LostFoundRow = z.infer<typeof lostFoundRow>;

const lostFoundDetailRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  kind_code: z.string(),
  item_type_code: z.string(),
  title: z.string(),
  description: nText,
  location_text: nText,
  last_seen_at: date.nullable(),
  reward_amount: nText,
  status_code: z.string(),
  reporter_member_id: z.string(),
  reporter_user_id: z.string(),
  contact_phone_e164: nText,
  updated_at: date,
  created_at: date,
  lat: nNumber,
  lng: nNumber,
});
export type LostFoundDetailRow = z.infer<typeof lostFoundDetailRow>;

const queueRow = z.object({
  kind: z.enum(['notice', 'lost_found']),
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: nText,
  template_code: nText,
  template_fields: z.record(z.unknown()),
  author_name: nText,
  created_at: date,
  open_reports: z.number(),
  status: z.string(),
});
export type QueueRow = z.infer<typeof queueRow>;

const routeRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  mode_code: z.string(),
  name_bn: z.string(),
  name_en: nText,
  operator_name: nText,
  origin_name: z.string(),
  destination_name: z.string(),
  fare_min: nText,
  fare_max: nText,
  fare_updated_on: nText,
  last_verified_at: date.nullable(),
  updated_at: date,
  distance_m: nNumber,
});
export type RouteRow = z.infer<typeof routeRow>;

const routeDetailRow = routeRow.extend({
  origin_lat: nNumber,
  origin_lng: nNumber,
  dest_lat: nNumber,
  dest_lng: nNumber,
  typical_duration_minutes: nNumber,
  contact_phones: z.array(z.string()),
  notes: nText,
  is_active: z.boolean(),
});
export type RouteDetailRow = z.infer<typeof routeDetailRow>;

const stopRow = z.object({
  seq: z.number(),
  name_bn: z.string(),
  name_en: nText,
  lat: nNumber,
  lng: nNumber,
  minutes_from_origin: nNumber,
  fare_from_origin: nText,
});
export type StopRow = z.infer<typeof stopRow>;

const scheduleRow = z.object({
  id: z.string(),
  direction_code: z.string(),
  departure_time: z.string(),
  iso_days_of_week: z.array(z.number()),
  valid_from: nText,
  valid_to: nText,
  service_class: nText,
  fare: nText,
});
export type ScheduleRow = z.infer<typeof scheduleRow>;

const departureRow = z.object({
  schedule_id: z.string(),
  direction_code: z.string(),
  departs_at: date,
  service_class: nText,
  fare: nText,
});
export type DepartureRow = z.infer<typeof departureRow>;

const govRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  slug: z.string(),
  category_code: z.string(),
  last_verified_on: z.string(),
  is_active: z.boolean(),
  updated_at: date,
  version_no: z.number(),
  name_bn: z.string(),
  name_en: nText,
  summary_bn: nText,
  office_name: z.string(),
  office_place_id: nText,
  address_text: nText,
  lat: nNumber,
  lng: nNumber,
  hours_text: nText,
  documents: z.array(z.string()),
  fees: z.array(z.object({ label: z.string(), amount: z.string() })),
  steps: z.array(z.string()),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  change_note: nText,
  version_created_at: date,
});
export type GovRow = z.infer<typeof govRow>;

const govVersionRow = govRow.pick({
  version_no: true,
  name_bn: true,
  name_en: true,
  summary_bn: true,
  office_name: true,
  office_place_id: true,
  address_text: true,
  lat: true,
  lng: true,
  hours_text: true,
  documents: true,
  fees: true,
  steps: true,
  links: true,
  change_note: true,
  version_created_at: true,
});
export type GovVersionRow = z.infer<typeof govVersionRow>;

const directoryRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  slug: z.string(),
  name_bn: z.string(),
  name_en: nText,
  category_slug: z.string(),
  subtype: nText,
  address: nText,
  lat: z.number(),
  lng: z.number(),
  is_24h: z.boolean(),
  verified_at: date.nullable(),
  updated_at: date,
  distance_m: z.number(),
});
export type DirectoryRow = z.infer<typeof directoryRow>;

const GOV_COLUMNS = sql`
  s.id, s.tenant_id, s.slug, s.category_code, s.last_verified_on::text as last_verified_on, s.is_active,
  s.updated_at, v.version_no, v.name_bn, v.name_en, v.summary_bn, v.office_name, v.office_place_id,
  v.address_text, st_y(v.location::geometry) as lat, st_x(v.location::geometry) as lng, v.hours_text,
  v.documents, v.fees, v.steps, v.links, v.change_note, v.created_at as version_created_at`;

@Injectable()
export class InfoEngineRepository {
  // ---- area facts -------------------------------------------------------------

  async tenantCenter(tx: DatabaseTransaction, tenantId: string): Promise<Origin | undefined> {
    const rows = await tx.execute(sql`
      select st_y(t.map_center::geometry) as lat, st_x(t.map_center::geometry) as lng
      from public.tenants t where t.id = ${tenantId}::uuid and t.map_center is not null`);
    return one(z.object({ lat: z.number(), lng: z.number() }), rows);
  }

  async tenantTimezone(tx: DatabaseTransaction, tenantId: string): Promise<string> {
    const rows = await tx.execute(
      sql`select timezone from public.tenants where id = ${tenantId}::uuid`,
    );
    return one(z.object({ timezone: z.string() }), rows)?.timezone ?? 'Asia/Dhaka';
  }

  async localities(
    tx: DatabaseTransaction,
  ): Promise<{ id: string; name_bn: string; name_en: string | null }[]> {
    const rows = await tx.execute(sql`
      select id, name_bn, name_en from public.localities
      where tenant_id = public.current_tenant_id() and is_active and deleted_at is null
      order by sort_order, name_bn`);
    return z
      .array(z.object({ id: z.string(), name_bn: z.string(), name_en: nText }))
      .parse([...rows]);
  }

  // ---- outages ------------------------------------------------------------------

  async outagesNear(
    tx: DatabaseTransaction,
    origin: Origin,
    radiusKm: number,
    limit: number,
  ): Promise<OutageRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, utility_code, area_bn, area_en, area_text, starts_at, ends_at, reason_text, updated_at,
             distance_m
      from public.utility_outages_near(${point(origin)}, ${radiusKm}::double precision, ${limit})`);
    return z.array(outageRow).parse([...rows]);
  }

  async outageClusters(
    tx: DatabaseTransaction,
    origin: Origin,
    radiusKm: number,
  ): Promise<ClusterRow[]> {
    const rows = await tx.execute(sql`
      select tenant_id, utility_code, locality_id, area_bn, area_en, reporters, first_at, last_at, distance_m
      from public.outage_report_clusters(${point(origin)}, ${radiusKm}::double precision)`);
    return z.array(clusterRow).parse([...rows]);
  }

  async reportOutage(
    tx: DatabaseTransaction,
    utility: string,
    at: Origin | null,
  ): Promise<{ locality_id: string | null; reporters: number }> {
    const rows = await tx.execute(sql`
      select locality_id, reporters from public.report_outage(${utility}, ${pointOrNull(at)})`);
    return one(z.object({ locality_id: nText, reporters: z.number() }), rows)!;
  }

  async teamOutages(tx: DatabaseTransaction): Promise<OutageAdminRow[]> {
    const rows = await tx.execute(sql`
      select id, utility_code, locality_id, area_text, starts_at, ends_at, reason_text, status_code
      from public.utility_outages
      where tenant_id = public.current_tenant_id() and deleted_at is null
        and (status_code = 'scheduled' or ends_at > now() - interval '7 days')
      order by starts_at desc, id desc`);
    return z.array(outageAdminRow).parse([...rows]);
  }

  async insertOutage(tx: DatabaseTransaction, input: OutageInput): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.utility_outages (utility_code, locality_id, area_text, starts_at, ends_at, reason_text,
                                          created_by_user_id)
      values (${input.utility}, ${input.localityId ?? null}::uuid, ${input.areaText ?? null},
              ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, ${input.reason ?? null},
              public.current_user_id())
      returning id`);
    return one(idRow, rows)!.id;
  }

  async updateOutage(tx: DatabaseTransaction, id: string, input: OutageInput): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.utility_outages
      set utility_code = ${input.utility}, locality_id = ${input.localityId ?? null}::uuid,
          area_text = ${input.areaText ?? null}, starts_at = ${input.startsAt}::timestamptz,
          ends_at = ${input.endsAt}::timestamptz, reason_text = ${input.reason ?? null}, status_code = 'scheduled'
      where id = ${id}::uuid and deleted_at is null
      returning id`);
    return [...rows].length > 0;
  }

  async cancelOutage(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.utility_outages set status_code = 'cancelled'
      where id = ${id}::uuid and deleted_at is null and status_code = 'scheduled'
      returning id`);
    return [...rows].length > 0;
  }

  // ---- notices --------------------------------------------------------------------

  async noticesNear(
    tx: DatabaseTransaction,
    origin: Origin,
    radiusKm: number,
    category: string | null,
    limit: number,
  ): Promise<NoticeRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, notice_type_code, category_code, title, body, issuer_name, is_official, is_pinned,
             template_code, template_fields, event_starts_at, event_ends_at, valid_from, expires_at, published_at,
             updated_at, area_bn, distance_m, attachments
      from public.notices_near(${point(origin)}, ${radiusKm}::double precision, ${category}, ${limit})`);
    return z.array(noticeRow).parse([...rows]);
  }

  /** One notice in its own area (RLS: published; staff and agents see all). */
  async notice(tx: DatabaseTransaction, id: string): Promise<NoticeDetailRow | undefined> {
    const rows = await tx.execute(sql`
      select n.id, n.tenant_id, n.notice_type_code, nt.category_code, n.title, n.body, n.issuer_name, n.is_official,
             n.is_pinned, n.template_code, n.template_fields, n.event_starts_at, n.event_ends_at, n.valid_from,
             n.expires_at, n.published_at, n.updated_at, t.name_bn as area_bn, null::double precision as distance_m,
             0 as attachments, n.status_code, n.published_by_member_id
      from public.notices n
      join public.notice_types nt on nt.code = n.notice_type_code
      join public.tenants t on t.id = n.tenant_id
      where n.id = ${id}::uuid and n.deleted_at is null`);
    return one(noticeDetailRow, rows);
  }

  /** The area a notice / lost & found item lives in (its routes run there). */
  async ownerTenant(
    tx: DatabaseTransaction,
    table: 'notices' | 'lost_found_items',
    id: string,
  ): Promise<string | undefined> {
    const rows =
      table === 'notices'
        ? await tx.execute(sql`select tenant_id from public.notices where id = ${id}::uuid`)
        : await tx.execute(
            sql`select tenant_id from public.lost_found_items where id = ${id}::uuid`,
          );
    return one(z.object({ tenant_id: z.string() }), rows)?.tenant_id;
  }

  async insertNotice(
    tx: DatabaseTransaction,
    input: NoticeInput,
    staff: boolean,
  ): Promise<{ id: string; status: string }> {
    const rows = await tx.execute(sql`
      insert into public.notices
        (notice_type_code, title, body, issuer_name, is_official, is_pinned, published_by_member_id, template_code,
         template_fields, event_starts_at, event_ends_at, valid_from, expires_at, status_code, published_at)
      values
        (${input.type}, ${input.title}, ${input.body}, ${input.issuerName ?? null}, ${staff && (input.isOfficial ?? false)},
         ${staff && (input.isPinned ?? false)}, public.current_member_id(), ${input.template ?? null},
         ${JSON.stringify(input.templateFields ?? {})}::jsonb, ${input.eventStartsAt ?? null}::timestamptz,
         ${input.eventEndsAt ?? null}::timestamptz, ${input.validFrom ?? null}::timestamptz,
         ${input.expiresAt ?? null}::timestamptz, 'published', now())
      returning id, status_code`);
    const row = one(z.object({ id: z.string(), status_code: z.string() }), rows)!;
    return { id: row.id, status: row.status_code };
  }

  /** A published notice without an end gets its type's expiry (notice_*_expiry_days). */
  async defaultNoticeExpiry(tx: DatabaseTransaction, id: string): Promise<void> {
    await tx.execute(sql`
      update public.notices n
      set expires_at = coalesce(n.valid_from, now()) + make_interval(days => (public.setting_value_for(
        case when n.notice_type_code = 'obituary' then 'notice_obituary_expiry_days'
             when nt.category_code = 'community' then 'notice_community_expiry_days'
             else 'notice_local_expiry_days' end, n.tenant_id) #>> '{}')::integer)
      from public.notice_types nt
      where n.id = ${id}::uuid and nt.code = n.notice_type_code and n.expires_at is null
        and n.status_code = 'published'`);
  }

  async attach(
    tx: DatabaseTransaction,
    owner: 'notice_id' | 'lost_found_item_id',
    ownerId: string,
    mediaIds: readonly string[],
  ): Promise<number> {
    let n = 0;
    for (const [i, mediaId] of mediaIds.entries()) {
      const rows =
        owner === 'notice_id'
          ? await tx.execute(sql`
              insert into public.media_attachments (media_asset_id, notice_id, sort_order)
              select m.id, ${ownerId}::uuid, ${i} from public.media_assets m
              where m.id = ${mediaId}::uuid and m.tenant_id = public.current_tenant_id()
                and m.kind_code in ('image', 'document') and m.deleted_at is null
              returning id`)
          : await tx.execute(sql`
              insert into public.media_attachments (media_asset_id, lost_found_item_id, sort_order)
              select m.id, ${ownerId}::uuid, ${i} from public.media_assets m
              where m.id = ${mediaId}::uuid and m.tenant_id = public.current_tenant_id()
                and m.kind_code = 'image' and m.deleted_at is null
              returning id`);
      n += [...rows].length;
    }
    return n;
  }

  /** Attachments with their storage keys (read as the system: documents are private). */
  async attachments(
    tx: DatabaseTransaction,
    owner: 'notice_id' | 'lost_found_item_id',
    ownerId: string,
  ): Promise<AttachmentRow[]> {
    const rows = await tx.execute(sql`
      select m.id, m.kind_code, m.mime_type, m.storage_key, m.variants, m.thumbhash
      from public.media_attachments a
      join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
      where ${owner === 'notice_id' ? sql`a.notice_id` : sql`a.lost_found_item_id`} = ${ownerId}::uuid
        and m.status_code = 'ready' and m.deleted_at is null
      order by a.sort_order, a.id`);
    return z.array(attachmentRow).parse([...rows]);
  }

  async report(
    tx: DatabaseTransaction,
    target: 'notice_id' | 'lost_found_item_id',
    id: string,
    reasonCode: string,
    details: string | null,
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.reports (reporter_member_id, ${target === 'notice_id' ? sql`notice_id` : sql`lost_found_item_id`},
                                  reason_code, details)
      values (public.current_member_id(), ${id}::uuid, ${reasonCode}, ${details})`);
  }

  // ---- lost & found ----------------------------------------------------------------

  async lostFoundNear(
    tx: DatabaseTransaction,
    q: {
      origin: Origin;
      radiusKm: number;
      kind: string | null;
      itemType: string | null;
      limit: number;
    },
  ): Promise<LostFoundRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, kind_code, item_type_code, title, description, location_text, last_seen_at,
             occurred_on::text as occurred_on, reward_amount, updated_at, created_at, lat, lng, distance_m,
             photo_variants, photo_thumbhash
      from public.lost_found_near(${point(q.origin)}, ${q.radiusKm}::double precision, ${q.kind}, ${q.itemType},
                                  ${q.limit})`);
    return z.array(lostFoundRow).parse([...rows]);
  }

  /** One item in its own area (RLS: open/resolved; the reporter and staff see more). */
  async lostFound(tx: DatabaseTransaction, id: string): Promise<LostFoundDetailRow | undefined> {
    const rows = await tx.execute(sql`
      select i.id, i.tenant_id, i.kind_code, i.item_type_code, i.title, i.description, i.location_text,
             i.last_seen_at, i.reward_amount::text as reward_amount, i.status_code, i.reporter_member_id,
             tm.user_id as reporter_user_id, i.contact_phone_e164, i.updated_at, i.created_at,
             st_y(i.location::geometry) as lat, st_x(i.location::geometry) as lng
      from public.lost_found_items i
      join public.tenant_members tm on tm.tenant_id = i.tenant_id and tm.id = i.reporter_member_id
      where i.id = ${id}::uuid and i.deleted_at is null`);
    return one(lostFoundDetailRow, rows);
  }

  async insertLostFound(
    tx: DatabaseTransaction,
    input: LostFoundInput,
  ): Promise<{ id: string; status: string }> {
    const rows = await tx.execute(sql`
      insert into public.lost_found_items
        (kind_code, item_type_code, title, description, location_text, location, last_seen_at, reporter_member_id,
         contact_via_code, contact_phone_e164, reward_amount, is_sensitive, occurred_on)
      values
        (${input.kind}, ${input.itemType}, ${input.title}, ${input.description ?? null}, ${input.locationText ?? null},
         ${pointOrNull(input.location)}, ${input.lastSeenAt ?? null}::timestamptz, public.current_member_id(), 'phone',
         coalesce(${input.contactPhone ?? null}, (select u.phone_e164 from public.users u where u.id = public.current_user_id())),
         ${input.reward ?? null}::numeric, ${input.itemType === 'person'},
         coalesce(${input.lastSeenAt ?? null}::timestamptz::date, current_date))
      returning id, status_code`);
    const row = one(z.object({ id: z.string(), status_code: z.string() }), rows)!;
    return { id: row.id, status: row.status_code };
  }

  async resolveLostFound(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.lost_found_items set status_code = 'resolved'
      where id = ${id}::uuid and reporter_member_id = public.current_member_id() and status_code = 'open'
      returning id`);
    return [...rows].length > 0;
  }

  async insertLead(
    tx: DatabaseTransaction,
    q: {
      channel: string;
      targetMemberId: string;
      actorMemberId: string | null;
      actorUserId: string | null;
      viewerKey: string;
    },
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.lead_events
        (channel_code, source_code, target_member_id, actor_member_id, actor_user_id, anon_session_hash)
      values (${q.channel}, 'lost_found', ${q.targetMemberId}::uuid, ${q.actorMemberId}::uuid,
              ${q.actorUserId}::uuid, ${q.viewerKey})`);
  }

  // ---- moderation ----------------------------------------------------------------

  async moderationQueue(tx: DatabaseTransaction, limit: number): Promise<QueueRow[]> {
    const rows = await tx.execute(sql`
      select q.kind, q.id, q.type, q.title, q.body, q.template_code, q.template_fields, q.author_name, q.created_at,
             q.open_reports, q.status
      from (
        select 'notice' as kind, n.id, n.notice_type_code as type, n.title, n.body, n.template_code,
               n.template_fields, up.display_name as author_name, n.created_at,
               (select count(*)::integer from public.reports r
                where r.tenant_id = n.tenant_id and r.notice_id = n.id and r.status_code = 'open') as open_reports,
               n.status_code as status
        from public.notices n
        join public.tenant_members tm on tm.tenant_id = n.tenant_id and tm.id = n.published_by_member_id
        left join public.user_profiles up on up.user_id = tm.user_id
        where n.tenant_id = public.current_tenant_id() and n.deleted_at is null
          and (n.status_code = 'pending_review'
               or exists (select 1 from public.reports r
                          where r.tenant_id = n.tenant_id and r.notice_id = n.id and r.status_code = 'open'))
        union all
        select 'lost_found', i.id, i.item_type_code, i.title, i.description, null, '{}'::jsonb, up.display_name,
               i.created_at,
               (select count(*)::integer from public.reports r
                where r.tenant_id = i.tenant_id and r.lost_found_item_id = i.id and r.status_code = 'open'),
               i.status_code
        from public.lost_found_items i
        join public.tenant_members tm on tm.tenant_id = i.tenant_id and tm.id = i.reporter_member_id
        left join public.user_profiles up on up.user_id = tm.user_id
        where i.tenant_id = public.current_tenant_id() and i.deleted_at is null
          and (i.status_code = 'pending_review'
               or exists (select 1 from public.reports r
                          where r.tenant_id = i.tenant_id and r.lost_found_item_id = i.id and r.status_code = 'open'))
      ) q (kind, id, type, title, body, template_code, template_fields, author_name, created_at, open_reports, status)
      order by open_reports desc, created_at
      limit ${limit}`);
    return z.array(queueRow).parse([...rows]);
  }

  async decide(
    tx: DatabaseTransaction,
    kind: 'notice' | 'lost_found',
    id: string,
    decision: string,
    reasonCode: string,
    reasonText: string | null,
  ): Promise<string> {
    const rows = await tx.execute(sql`
      select public.decide_info_item(${kind}, ${id}::uuid, ${decision}, ${reasonCode}, ${reasonText}) as status`);
    return one(z.object({ status: z.string() }), rows)!.status;
  }

  /** Who posted a notice or a lost & found report, and its status — for the decision notice. */
  async infoAuthor(
    tx: DatabaseTransaction,
    kind: 'notice' | 'lost_found',
    id: string,
  ): Promise<{ user_id: string; title: string; status_code: string } | undefined> {
    const rows = await tx.execute(
      kind === 'notice'
        ? sql`
            select tm.user_id, n.title, n.status_code from public.notices n
            join public.tenant_members tm on tm.tenant_id = n.tenant_id and tm.id = n.published_by_member_id
            where n.tenant_id = public.current_tenant_id() and n.id = ${id}::uuid`
        : sql`
            select tm.user_id, i.title, i.status_code from public.lost_found_items i
            join public.tenant_members tm on tm.tenant_id = i.tenant_id and tm.id = i.reporter_member_id
            where i.tenant_id = public.current_tenant_id() and i.id = ${id}::uuid`,
    );
    return one(z.object({ user_id: z.string(), title: z.string(), status_code: z.string() }), rows);
  }

  /** A decision closes the item's open reports (the moderation_actions row is the record). */
  async closeReports(
    tx: DatabaseTransaction,
    kind: 'notice' | 'lost_found',
    id: string,
    removed: boolean,
  ): Promise<void> {
    await tx.execute(sql`
      update public.reports
      set status_code = ${removed ? 'actioned' : 'dismissed'}, resolution_code = ${removed ? 'content_removed' : 'no_action'},
          resolved_at = now()
      where tenant_id = public.current_tenant_id() and status_code in ('open', 'in_review')
        and ${kind === 'notice' ? sql`notice_id` : sql`lost_found_item_id`} = ${id}::uuid`);
  }

  // ---- transport -----------------------------------------------------------------

  async routesNear(
    tx: DatabaseTransaction,
    origin: Origin,
    radiusKm: number,
    mode: string | null,
    limit: number,
  ): Promise<RouteRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, mode_code, name_bn, name_en, operator_name, origin_name, destination_name, fare_min,
             fare_max, fare_updated_on::text as fare_updated_on, last_verified_at, updated_at, distance_m
      from public.transport_routes_near(${point(origin)}, ${radiusKm}::double precision, ${mode}, ${limit})`);
    return z.array(routeRow).parse([...rows]);
  }

  async routeTenant(tx: DatabaseTransaction, id: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select tenant_id from public.transport_routes where id = ${id}::uuid`,
    );
    return one(z.object({ tenant_id: z.string() }), rows)?.tenant_id;
  }

  /** One route in its own area (RLS: active, or the team). */
  async route(tx: DatabaseTransaction, id: string): Promise<RouteDetailRow | undefined> {
    const rows = await tx.execute(sql`
      select r.id, r.tenant_id, r.mode_code, r.name_bn, r.name_en, r.operator_name, r.origin_name,
             r.destination_name, r.fare_min::text as fare_min, r.fare_max::text as fare_max,
             r.fare_updated_on::text as fare_updated_on, r.last_verified_at, r.updated_at,
             null::double precision as distance_m,
             st_y(r.origin_location::geometry) as origin_lat, st_x(r.origin_location::geometry) as origin_lng,
             st_y(r.destination_location::geometry) as dest_lat, st_x(r.destination_location::geometry) as dest_lng,
             r.typical_duration_minutes, r.contact_phones, r.notes, r.is_active
      from public.transport_routes r where r.id = ${id}::uuid and r.deleted_at is null`);
    return one(routeDetailRow, rows);
  }

  async stops(tx: DatabaseTransaction, routeId: string): Promise<StopRow[]> {
    const rows = await tx.execute(sql`
      select seq, name_bn, name_en, st_y(location::geometry) as lat, st_x(location::geometry) as lng,
             minutes_from_origin, fare_from_origin::text as fare_from_origin
      from public.transport_route_stops where transport_route_id = ${routeId}::uuid order by seq`);
    return z.array(stopRow).parse([...rows]);
  }

  async schedules(tx: DatabaseTransaction, routeId: string): Promise<ScheduleRow[]> {
    const rows = await tx.execute(sql`
      select id, direction_code, to_char(departure_time, 'HH24:MI') as departure_time,
             iso_days_of_week::integer[] as iso_days_of_week, valid_from::text as valid_from,
             valid_to::text as valid_to, service_class, fare::text as fare
      from public.transport_schedules where transport_route_id = ${routeId}::uuid
      order by direction_code, departure_time`);
    return z.array(scheduleRow).parse([...rows]);
  }

  async nextDepartures(
    tx: DatabaseTransaction,
    routeId: string,
    at: Date,
    limit: number,
  ): Promise<DepartureRow[]> {
    const rows = await tx.execute(sql`
      select schedule_id, direction_code, departs_at, service_class, fare
      from public.transport_next_departures(${routeId}::uuid, ${at.toISOString()}::timestamptz, ${limit})`);
    return z.array(departureRow).parse([...rows]);
  }

  async teamRoutes(tx: DatabaseTransaction): Promise<RouteDetailRow[]> {
    const rows = await tx.execute(sql`
      select r.id, r.tenant_id, r.mode_code, r.name_bn, r.name_en, r.operator_name, r.origin_name,
             r.destination_name, r.fare_min::text as fare_min, r.fare_max::text as fare_max,
             r.fare_updated_on::text as fare_updated_on, r.last_verified_at, r.updated_at,
             null::double precision as distance_m,
             st_y(r.origin_location::geometry) as origin_lat, st_x(r.origin_location::geometry) as origin_lng,
             st_y(r.destination_location::geometry) as dest_lat, st_x(r.destination_location::geometry) as dest_lng,
             r.typical_duration_minutes, r.contact_phones, r.notes, r.is_active
      from public.transport_routes r
      where r.tenant_id = public.current_tenant_id() and r.deleted_at is null
      order by r.mode_code, r.name_bn`);
    return z.array(routeDetailRow).parse([...rows]);
  }

  /** Saves a route with its stops and timetable (replaced whole: one form, one save). */
  async saveRoute(
    tx: DatabaseTransaction,
    id: string | null,
    input: RouteInput,
  ): Promise<string | undefined> {
    const values = sql`${input.mode}, ${input.nameBn}, ${input.nameEn ?? null}, ${input.operatorName ?? null},
      ${input.originName}, ${input.destinationName}, ${pointOrNull(input.originLocation)},
      ${pointOrNull(input.destinationLocation)}, ${input.typicalDurationMinutes ?? null}::integer,
      ${input.fareMin ?? null}::numeric, ${input.fareMax ?? null}::numeric, ${textArray(input.contactPhones)},
      ${input.notes ?? null}`;
    const fareChanged = sql`case when ${input.fareMin ?? null}::numeric is not null
                                   or ${input.fareMax ?? null}::numeric is not null
                                 then public.tenant_local_today(public.current_tenant_id()) end`;
    const saved = id
      ? await tx.execute(sql`
          update public.transport_routes
          set (mode_code, name_bn, name_en, operator_name, origin_name, destination_name, origin_location,
               destination_location, typical_duration_minutes, fare_min, fare_max, contact_phones, notes) = (${values}),
              fare_updated_on = case when (fare_min, fare_max) is distinct from
                                          (${input.fareMin ?? null}::numeric, ${input.fareMax ?? null}::numeric)
                                     then ${fareChanged} else fare_updated_on end,
              last_verified_at = now(), is_active = true
          where id = ${id}::uuid and deleted_at is null
          returning id`)
      : await tx.execute(sql`
          insert into public.transport_routes
            (mode_code, name_bn, name_en, operator_name, origin_name, destination_name, origin_location,
             destination_location, typical_duration_minutes, fare_min, fare_max, contact_phones, notes,
             fare_updated_on, last_verified_at)
          values (${values}, ${fareChanged}, now())
          returning id`);
    const routeId = one(idRow, saved)?.id;
    if (!routeId) return undefined;
    await tx.execute(
      sql`delete from public.transport_route_stops where transport_route_id = ${routeId}::uuid`,
    );
    await tx.execute(
      sql`delete from public.transport_schedules where transport_route_id = ${routeId}::uuid`,
    );
    for (const [i, stop] of input.stops.entries()) {
      await tx.execute(sql`
        insert into public.transport_route_stops
          (transport_route_id, seq, name_bn, location, minutes_from_origin, fare_from_origin)
        values (${routeId}::uuid, ${i + 1}, ${stop.nameBn}, ${pointOrNull(stop.location)},
                ${stop.minutesFromOrigin ?? null}::integer, ${stop.fareFromOrigin ?? null}::numeric)`);
    }
    for (const s of input.schedules) {
      await tx.execute(sql`
        insert into public.transport_schedules
          (transport_route_id, direction_code, departure_time, iso_days_of_week, valid_from, valid_to, service_class,
           fare)
        values (${routeId}::uuid, ${s.direction}, ${s.departureTime}::time, ${smallintArray(s.days)},
                ${s.validFrom ?? null}::date, ${s.validTo ?? null}::date, ${s.serviceClass ?? null},
                ${s.fare ?? null}::numeric)`);
    }
    return routeId;
  }

  async verifyRoute(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.transport_routes set last_verified_at = now()
      where id = ${id}::uuid and deleted_at is null returning id`);
    return [...rows].length > 0;
  }

  async removeRoute(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.transport_routes set deleted_at = now(), is_active = false
      where id = ${id}::uuid and deleted_at is null returning id`);
    return [...rows].length > 0;
  }

  // ---- government service guide ------------------------------------------------------

  /** The area's board (current versions), by category. */
  async govServices(
    tx: DatabaseTransaction,
    category: string | null,
    includeInactive: boolean,
  ): Promise<GovRow[]> {
    const rows = await tx.execute(sql`
      select ${GOV_COLUMNS}
      from public.gov_services s
      join public.gov_service_versions v on v.tenant_id = s.tenant_id and v.id = s.current_version_id
      where s.tenant_id = public.current_tenant_id() and s.deleted_at is null
        and (${includeInactive} or s.is_active)
        and (${category}::text is null or s.category_code = ${category})
      order by s.category_code, v.name_bn`);
    return z.array(govRow).parse([...rows]);
  }

  async govService(tx: DatabaseTransaction, slug: string): Promise<GovRow | undefined> {
    const rows = await tx.execute(sql`
      select ${GOV_COLUMNS}
      from public.gov_services s
      join public.gov_service_versions v on v.tenant_id = s.tenant_id and v.id = s.current_version_id
      where s.tenant_id = public.current_tenant_id() and s.deleted_at is null
        -- By slug, or by id (the card carries the id).
        and (s.slug = ${slug} or s.id::text = ${slug})`);
    return one(govRow, rows);
  }

  async govVersions(
    tx: DatabaseTransaction,
    serviceId: string,
  ): Promise<{ version_no: number; created_at: Date; change_note: string | null }[]> {
    const rows = await tx.execute(sql`
      select version_no, created_at, change_note from public.gov_service_versions
      where gov_service_id = ${serviceId}::uuid order by version_no desc`);
    return z
      .array(z.object({ version_no: z.number(), created_at: date, change_note: nText }))
      .parse([...rows]);
  }

  async govVersion(
    tx: DatabaseTransaction,
    serviceId: string,
    no: number,
  ): Promise<GovVersionRow | undefined> {
    const rows = await tx.execute(sql`
      select v.version_no, v.name_bn, v.name_en, v.summary_bn, v.office_name, v.office_place_id, v.address_text,
             st_y(v.location::geometry) as lat, st_x(v.location::geometry) as lng, v.hours_text, v.documents, v.fees,
             v.steps, v.links, v.change_note, v.created_at as version_created_at
      from public.gov_service_versions v
      where v.gov_service_id = ${serviceId}::uuid and v.version_no = ${no}`);
    return one(govVersionRow, rows);
  }

  async govPublish(
    tx: DatabaseTransaction,
    serviceId: string | null,
    input: GovServiceInput,
  ): Promise<{ service_id: string; version_no: number }> {
    const payload = {
      name_bn: input.nameBn,
      name_en: input.nameEn ?? null,
      summary_bn: input.summaryBn ?? null,
      office_name: input.officeName,
      office_place_id: input.officePlaceId ?? null,
      address_text: input.address ?? null,
      lat: input.location?.lat ?? null,
      lng: input.location?.lng ?? null,
      hours_text: input.hours ?? null,
      documents: input.documents,
      fees: input.fees.map((f) => ({ label: f.label, amount: normalizeMoney(f.amount) })),
      steps: input.steps,
      links: input.links,
      change_note: input.changeNote ?? null,
    };
    const rows = await tx.execute(sql`
      select service_id, version_no
      from public.gov_service_publish(${serviceId}::uuid, ${input.slug}, ${input.category},
                                      ${JSON.stringify(payload)}::jsonb)`);
    return one(z.object({ service_id: z.string(), version_no: z.number() }), rows)!;
  }

  async govVerify(tx: DatabaseTransaction, serviceId: string): Promise<void> {
    await tx.execute(sql`select public.gov_service_verify(${serviceId}::uuid)`);
  }

  async govSetActive(
    tx: DatabaseTransaction,
    serviceId: string,
    active: boolean,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.gov_services set is_active = ${active}
      where id = ${serviceId}::uuid and deleted_at is null returning id`);
    return [...rows].length > 0;
  }

  // ---- directories ---------------------------------------------------------------------

  async directoryNear(
    tx: DatabaseTransaction,
    q: {
      origin: Origin;
      radiusKm: number;
      categories: string[];
      fieldKey: string | null;
      fieldValues: string[] | null;
      only24h: boolean;
      after: { distance: number; id: string } | null;
      limit: number;
    },
  ): Promise<DirectoryRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, slug, name_bn, name_en, category_slug, subtype, address, lat, lng, is_24h, verified_at,
             updated_at, distance_m
      from public.directory_places_near(${point(q.origin)}, ${q.radiusKm}::double precision,
                                        ${textArray(q.categories)}, ${q.fieldKey}, ${textArray(q.fieldValues)},
                                        ${q.only24h}, ${q.after?.distance ?? null}::double precision,
                                        ${q.after?.id ?? null}::uuid, ${q.limit})`);
    return z.array(directoryRow).parse([...rows]);
  }

  async openStates(
    tx: DatabaseTransaction,
    ids: readonly string[],
  ): Promise<Map<string, { state: string; changes_at: Date | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.execute(sql`
      select id, state, changes_at from public.open_states('place', ${uuidArray(ids)}, now())`);
    const parsed = z
      .array(z.object({ id: z.string(), state: z.string(), changes_at: date.nullable() }))
      .parse([...rows]);
    return new Map(parsed.map((r) => [r.id, { state: r.state, changes_at: r.changes_at }]));
  }

  // ---- the job -----------------------------------------------------------------------------

  async expire(
    tx: DatabaseTransaction,
    limit: number,
  ): Promise<{ notices: number; lost_found: number; outages: number }> {
    const rows = await tx.execute(
      sql`select notices, lost_found, outages from public.expire_info_items(${limit})`,
    );
    return one(
      z.object({ notices: z.number(), lost_found: z.number(), outages: z.number() }),
      rows,
    )!;
  }
}
