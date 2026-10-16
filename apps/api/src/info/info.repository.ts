import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type {
  BazarCatalogueInput,
  BazarSponsorInput,
  EmergencyContactInput,
  RegisterDonorInput,
} from './dto/info.dto';

/**
 * Local information reads and writes (ADR 064). Two kinds:
 *  - across areas (rule 10): the SECURITY DEFINER functions of 0060
 *    (emergency_contacts_near, blood_donors_near, blood_requests_near…), each
 *    checking its caller itself;
 *  - one area: plain statements in that area's context, under its RLS.
 * No SELECT *, every row parsed with zod.
 */

export type BazarBoardKind = 'bazar' | 'agri';

export interface Origin {
  lat: number;
  lng: number;
}

function point(origin: Origin): SQL {
  return sql`st_setsrid(st_makepoint(${origin.lng}, ${origin.lat}), 4326)::geography`;
}

function textArray(values: readonly string[] | null): SQL {
  return values === null ? sql`null::text[]` : sql`${`{${values.join(',')}}`}::text[]`;
}

const date = z.coerce.date();
const nullableText = z.string().nullable();
const nullableNumber = z.number().nullable();

const hotlineRow = z.object({
  id: z.string(),
  service_type_code: z.string(),
  name_bn: z.string(),
  name_en: z.string(),
  description_bn: nullableText,
  description_en: nullableText,
  dial_string: z.string(),
});
export type HotlineRow = z.infer<typeof hotlineRow>;

const emergencyRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  service_type_code: z.string(),
  name_bn: z.string(),
  name_en: nullableText,
  phones: z.array(z.string()),
  address_text: nullableText,
  lat: nullableNumber,
  lng: nullableNumber,
  is_24h: z.boolean(),
  availability_note: nullableText,
  last_verified_at: date.nullable(),
  distance_m: nullableNumber,
  sort_order: z.number(),
});
export type EmergencyRow = z.infer<typeof emergencyRow>;
const emergencyAdminRow = emergencyRow.extend({ is_active: z.boolean() });
export type EmergencyAdminRow = z.infer<typeof emergencyAdminRow>;

const donorNearRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  distance_m: z.number(),
  blood_group_code: z.string(),
  display_name: nullableText,
  area_bn: nullableText,
  area_en: nullableText,
  contact_window_code: z.string(),
  contact_preference_code: z.string(),
  last_donated_on: nullableText,
});
export type DonorNearRow = z.infer<typeof donorNearRow>;

const myDonorRow = z.object({
  id: z.string(),
  blood_group_code: z.string(),
  locality_id: nullableText,
  lat: nullableNumber,
  lng: nullableNumber,
  last_donated_on: nullableText,
  eligible_from: nullableText,
  is_available: z.boolean(),
  is_listed: z.boolean(),
  contact_window_code: z.string(),
  contact_preference_code: z.string(),
  alerts_enabled: z.boolean(),
  contacts_today: z.number(),
});
export type MyDonorRow = z.infer<typeof myDonorRow>;

const donorContactRow = z.object({
  id: z.string(),
  created_at: date,
  requester_name: nullableText,
  channel_code: z.string(),
  request_id: nullableText,
  request_group: nullableText,
  request_hospital: nullableText,
  request_needed_by: date.nullable(),
  request_status: nullableText,
});
export type DonorContactRow = z.infer<typeof donorContactRow>;

const contactTargetRow = z.object({
  tenant_id: z.string(),
  member_id: z.string(),
  user_id: z.string(),
  contact_preference_code: z.string(),
  phone_e164: nullableText,
  display_name: nullableText,
  blood_group_code: z.string(),
});
export type ContactTargetRow = z.infer<typeof contactTargetRow>;

const requestNearRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  distance_m: z.number(),
  blood_group_code: z.string(),
  units_needed: z.number(),
  hospital_name: z.string(),
  needed_by: date,
  urgency_code: z.string(),
  created_at: date,
  is_mine: z.boolean(),
});
export type RequestNearRow = z.infer<typeof requestNearRow>;

const requestRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  requester_member_id: z.string(),
  requester_user_id: z.string(),
  requester_name: nullableText,
  blood_group_code: z.string(),
  units_needed: z.number(),
  hospital_name: z.string(),
  patient_note: nullableText,
  contact_phone_e164: z.string(),
  needed_by: date,
  urgency_code: z.string(),
  status_code: z.string(),
  created_at: date,
  lat: nullableNumber,
  lng: nullableNumber,
});
export type RequestRow = z.infer<typeof requestRow>;

const alertRow = z.object({
  alert_id: z.string(),
  donor_user_id: z.string(),
  donor_tenant_id: z.string(),
  distance_m: z.number(),
});
export type AlertRow = z.infer<typeof alertRow>;

const catalogueRow = z.object({
  commodity_id: z.string(),
  code: z.string(),
  name_bn: z.string(),
  name_en: z.string(),
  group_code: z.string(),
  unit_code: z.string(),
  sort_order: z.number(),
});
export type CatalogueRow = z.infer<typeof catalogueRow>;

const dayPriceRow = z.object({
  commodity_id: z.string(),
  unit_code: z.string(),
  price_date: z.string(),
  min_price: z.string(),
  max_price: z.string(),
});
export type DayPriceRow = z.infer<typeof dayPriceRow>;

const sponsorRow = z.object({
  id: z.string(),
  name_bn: z.string(),
  name_en: nullableText,
  tagline_bn: nullableText,
  link_url: nullableText,
  starts_on: z.string(),
  ends_on: nullableText,
});
export type SponsorRow = z.infer<typeof sponsorRow>;

const commodityRow = z.object({
  id: z.string(),
  code: z.string(),
  name_bn: z.string(),
  name_en: z.string(),
  group_code: z.string(),
  default_unit_code: z.string(),
  selected_unit: nullableText,
  selected_sort: nullableNumber,
});
export type CommodityRow = z.infer<typeof commodityRow>;

const one = <T extends z.ZodTypeAny>(schema: T, rows: Iterable<unknown>): z.infer<T> | undefined =>
  z.array(schema).parse([...rows])[0];

@Injectable()
export class InfoRepository {
  // ---- area facts -----------------------------------------------------------

  async tenantCenter(tx: DatabaseTransaction, tenantId: string): Promise<Origin | undefined> {
    const rows = await tx.execute(sql`
      select st_y(t.map_center::geometry) as lat, st_x(t.map_center::geometry) as lng
      from public.tenants t
      where t.id = ${tenantId}::uuid and t.map_center is not null`);
    return one(z.object({ lat: z.number(), lng: z.number() }), rows);
  }

  async localToday(tx: DatabaseTransaction, tenantId: string): Promise<string> {
    const rows = await tx.execute(
      sql`select public.tenant_local_today(${tenantId}::uuid)::text as today`,
    );
    return one(z.object({ today: z.string() }), rows)!.today;
  }

  // ---- emergency ------------------------------------------------------------

  async hotlines(tx: DatabaseTransaction): Promise<HotlineRow[]> {
    const rows = await tx.execute(sql`
      select h.id, h.service_type_code, h.name_bn, h.name_en, h.description_bn, h.description_en,
             h.dial_string
      from public.national_hotlines h
      where h.is_active
      order by h.sort_order, h.id`);
    return z.array(hotlineRow).parse([...rows]);
  }

  /** The service types in the lookup's order (the page's group order). */
  async serviceTypeOrder(tx: DatabaseTransaction): Promise<string[]> {
    const rows = await tx.execute(sql`
      select code from public.emergency_service_types where is_active order by sort_order, code`);
    return z
      .array(z.object({ code: z.string() }))
      .parse([...rows])
      .map((r) => r.code);
  }

  async emergencyNear(
    tx: DatabaseTransaction,
    origin: Origin,
    radiusKm: number,
    tenantId: string,
    limit: number,
  ): Promise<EmergencyRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, service_type_code, name_bn, name_en, phones, address_text, lat, lng, is_24h,
             availability_note, last_verified_at, distance_m, sort_order
      from public.emergency_contacts_near(${point(origin)}, ${radiusKm}::double precision,
                                          ${tenantId}::uuid, ${limit})`);
    return z.array(emergencyRow).parse([...rows]);
  }

  /** The area's own contacts, inactive ones too (staff and agents). */
  async emergencyAdminList(tx: DatabaseTransaction): Promise<EmergencyAdminRow[]> {
    const rows = await tx.execute(sql`
      select e.id, e.tenant_id, e.service_type_code, e.name_bn, e.name_en, e.phones, e.address_text,
             st_y(e.location::geometry) as lat, st_x(e.location::geometry) as lng, e.is_24h,
             e.availability_note, e.last_verified_at, null::double precision as distance_m, e.sort_order,
             e.is_active
      from public.emergency_contacts e
      where e.tenant_id = public.current_tenant_id() and e.deleted_at is null
      order by e.service_type_code, e.sort_order, e.id`);
    return z.array(emergencyAdminRow).parse([...rows]);
  }

  async insertEmergency(tx: DatabaseTransaction, input: EmergencyContactInput): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.emergency_contacts
        (service_type_code, name_bn, name_en, phones, address_text, location, is_24h, availability_note,
         sort_order, is_active, last_verified_at, verified_by_user_id)
      values
        (${input.serviceType}, ${input.nameBn}, ${input.nameEn ?? null}, ${textArray(input.phones)},
         ${input.address ?? null}, ${input.location ? point(input.location) : sql`null`}, ${input.is24h},
         ${input.availabilityNote ?? null}, ${input.sortOrder}, ${input.isActive}, now(),
         public.current_user_id())
      returning id`);
    return one(z.object({ id: z.string() }), rows)!.id;
  }

  async updateEmergency(
    tx: DatabaseTransaction,
    id: string,
    input: EmergencyContactInput,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.emergency_contacts
      set service_type_code = ${input.serviceType}, name_bn = ${input.nameBn}, name_en = ${input.nameEn ?? null},
          phones = ${textArray(input.phones)}, address_text = ${input.address ?? null},
          location = ${input.location ? point(input.location) : sql`null`}, is_24h = ${input.is24h},
          availability_note = ${input.availabilityNote ?? null}, sort_order = ${input.sortOrder},
          is_active = ${input.isActive}, last_verified_at = now(), verified_by_user_id = public.current_user_id()
      where id = ${id}::uuid and deleted_at is null
      returning id`);
    return [...rows].length > 0;
  }

  /** A field check: the contact still works (agents re-verify, ADR 064). */
  async verifyEmergency(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.emergency_contacts
      set last_verified_at = now(), verified_by_user_id = public.current_user_id()
      where id = ${id}::uuid and deleted_at is null
      returning id`);
    return [...rows].length > 0;
  }

  async deleteEmergency(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.emergency_contacts set deleted_at = now(), is_active = false
      where id = ${id}::uuid and deleted_at is null
      returning id`);
    return [...rows].length > 0;
  }

  // ---- blood: donors ----------------------------------------------------------

  async donorsNear(
    tx: DatabaseTransaction,
    q: {
      origin: Origin;
      radiusKm: number;
      groups: string[];
      after: { distance: number; id: string } | null;
      limit: number;
    },
  ): Promise<DonorNearRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, distance_m, blood_group_code, display_name, area_bn, area_en,
             contact_window_code, contact_preference_code, last_donated_on::text as last_donated_on
      from public.blood_donors_near(${point(q.origin)}, ${q.radiusKm}::double precision,
                                    ${textArray(q.groups)}, ${q.after?.distance ?? null}::double precision,
                                    ${q.after?.id ?? null}::uuid, ${q.limit})`);
    return z.array(donorNearRow).parse([...rows]);
  }

  /** Donor groups a recipient of `group` can take (blood_group_compatibility). */
  async compatibleDonorGroups(tx: DatabaseTransaction, group: string): Promise<string[]> {
    const rows = await tx.execute(sql`
      select donor_code from public.blood_group_compatibility where recipient_code = ${group}
      order by donor_code`);
    return z
      .array(z.object({ donor_code: z.string() }))
      .parse([...rows])
      .map((r) => r.donor_code);
  }

  /** The caller's donor row in this area (RLS: the owner), with today's contact count. */
  async myDonor(tx: DatabaseTransaction): Promise<MyDonorRow | undefined> {
    const rows = await tx.execute(sql`
      select d.id, d.blood_group_code, d.locality_id, st_y(d.approx_location::geometry) as lat,
             st_x(d.approx_location::geometry) as lng, d.last_donated_on::text as last_donated_on,
             d.eligible_from::text as eligible_from, d.is_available,
             d.is_available and (d.eligible_from is null
                                 or d.eligible_from <= public.tenant_local_today(d.tenant_id)) as is_listed,
             d.contact_window_code, d.contact_preference_code, d.alerts_enabled,
             (select count(*)::integer from public.blood_donor_contacts c
              where c.tenant_id = d.tenant_id and c.blood_donor_id = d.id
                and c.created_at > now() - interval '1 day') as contacts_today
      from public.blood_donors d
      where d.tenant_id = public.current_tenant_id() and d.member_id = public.current_member_id()
        and d.deleted_at is null`);
    return one(myDonorRow, rows);
  }

  /** Registers or updates the caller's donor row (one per member and area). */
  async upsertDonor(tx: DatabaseTransaction, input: RegisterDonorInput): Promise<string> {
    const values = sql`${input.bloodGroup}, ${input.localityId ?? null}::uuid, ${point(input.location)},
      ${input.lastDonatedOn ?? null}::date, ${input.contactWindow}, ${input.contactPreference},
      ${input.alertsEnabled}`;
    const updated = await tx.execute(sql`
      update public.blood_donors
      set (blood_group_code, locality_id, approx_location, last_donated_on, contact_window_code,
           contact_preference_code, alerts_enabled) = (${values}),
          eligibility_confirmed_at = now()
      where tenant_id = public.current_tenant_id() and member_id = public.current_member_id()
        and deleted_at is null
      returning id`);
    const existing = one(z.object({ id: z.string() }), updated);
    if (existing) return existing.id;
    const inserted = await tx.execute(sql`
      insert into public.blood_donors
        (member_id, blood_group_code, locality_id, approx_location, last_donated_on, contact_window_code,
         contact_preference_code, alerts_enabled, eligibility_confirmed_at)
      values (public.current_member_id(), ${values}, now())
      returning id`);
    return one(z.object({ id: z.string() }), inserted)!.id;
  }

  /** The blood_donor_listing consent, recorded once per registration (user_consents). */
  async recordDonorConsent(
    tx: DatabaseTransaction,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.user_consents (user_id, consent_type_code, granted, ip_address, user_agent)
      values (public.current_user_id(), 'blood_donor_listing', true, ${meta.ip}::inet, ${meta.userAgent})`);
  }

  async setAvailability(tx: DatabaseTransaction, available: boolean): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.blood_donors set is_available = ${available}
      where tenant_id = public.current_tenant_id() and member_id = public.current_member_id()
        and deleted_at is null
      returning id`);
    return [...rows].length > 0;
  }

  /** A recorded donation: eligible_from follows by trigger (blood_donation_interval_days). */
  async recordDonation(tx: DatabaseTransaction, donatedOn: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.blood_donors
      set last_donated_on = greatest(coalesce(last_donated_on, ${donatedOn}::date), ${donatedOn}::date)
      where tenant_id = public.current_tenant_id() and member_id = public.current_member_id()
        and deleted_at is null
      returning id`);
    return [...rows].length > 0;
  }

  async withdrawDonor(tx: DatabaseTransaction): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.blood_donors set deleted_at = now(), is_available = false
      where tenant_id = public.current_tenant_id() and member_id = public.current_member_id()
        and deleted_at is null
      returning id`);
    return [...rows].length > 0;
  }

  async myDonorContacts(tx: DatabaseTransaction, limit: number): Promise<DonorContactRow[]> {
    const rows = await tx.execute(sql`
      select c.id, c.created_at, up.display_name as requester_name, c.channel_code,
             r.id as request_id, r.blood_group_code as request_group, r.hospital_name as request_hospital,
             r.needed_by as request_needed_by, r.status_code as request_status
      from public.blood_donor_contacts c
      left join public.user_profiles up on up.user_id = c.requester_user_id
      left join lateral (
        select br.id, br.blood_group_code, br.hospital_name, br.needed_by, br.status_code
        from public.blood_requests br where br.id = c.blood_request_id
      ) r on true
      where c.tenant_id = public.current_tenant_id()
      order by c.created_at desc, c.id desc
      limit ${limit}`);
    return z.array(donorContactRow).parse([...rows]);
  }

  async donorContactTarget(
    tx: DatabaseTransaction,
    donorId: string,
  ): Promise<ContactTargetRow | undefined> {
    const rows = await tx.execute(sql`
      select tenant_id, member_id, user_id, contact_preference_code, phone_e164, display_name,
             blood_group_code
      from public.blood_donor_contact_target(${donorId}::uuid)`);
    return one(contactTargetRow, rows);
  }

  async recordDonorContact(
    tx: DatabaseTransaction,
    q: { donorId: string; channel: string; requestId: string | null; viewerKey: string },
  ): Promise<string> {
    const rows = await tx.execute(sql`
      select public.blood_donor_record_contact(${q.donorId}::uuid, ${q.channel}, ${q.requestId}::uuid,
                                               ${q.viewerKey}) as id`);
    return one(z.object({ id: z.string() }), rows)!.id;
  }

  async myDisplayName(tx: DatabaseTransaction): Promise<string | null> {
    const rows = await tx.execute(sql`
      select up.display_name from public.user_profiles up where up.user_id = public.current_user_id()`);
    return one(z.object({ display_name: z.string() }), rows)?.display_name ?? null;
  }

  /** The tenant a donor lives in (the contact path runs there). */
  async donorTenant(tx: DatabaseTransaction, donorId: string): Promise<string | undefined> {
    const rows = await tx.execute(sql`
      select tenant_id from public.blood_donor_contact_target(${donorId}::uuid)`);
    return one(z.object({ tenant_id: z.string() }), rows)?.tenant_id;
  }

  // ---- blood: requests ----------------------------------------------------------

  async requestsNear(
    tx: DatabaseTransaction,
    q: { origin: Origin; radiusKm: number; groups: string[] | null; limit: number },
  ): Promise<RequestNearRow[]> {
    const rows = await tx.execute(sql`
      select id, tenant_id, distance_m, blood_group_code, units_needed, hospital_name, needed_by,
             urgency_code, created_at, is_mine
      from public.blood_requests_near(${point(q.origin)}, ${q.radiusKm}::double precision,
                                      ${textArray(q.groups)}, ${q.limit})`);
    return z.array(requestNearRow).parse([...rows]);
  }

  async requestsSummaryNear(
    tx: DatabaseTransaction,
    origin: Origin,
    radiusKm: number,
  ): Promise<{ open_count: number; groups: string[]; most_urgent: string | null }> {
    const rows = await tx.execute(sql`
      select open_count, groups, most_urgent
      from public.blood_requests_summary_near(${point(origin)}, ${radiusKm}::double precision)`);
    return one(
      z.object({ open_count: z.number(), groups: z.array(z.string()), most_urgent: nullableText }),
      rows,
    )!;
  }

  async openRequestCount(tx: DatabaseTransaction, userId: string): Promise<number> {
    // Across areas: the cap is per person (blood_request_max_open_per_user).
    const rows = await tx.execute(sql`
      select count(*)::integer as n
      from public.blood_requests r
      join public.tenant_members tm on tm.tenant_id = r.tenant_id and tm.id = r.requester_member_id
      where tm.user_id = ${userId}::uuid and r.status_code = 'open' and r.deleted_at is null`);
    return one(z.object({ n: z.number() }), rows)!.n;
  }

  async insertRequest(
    tx: DatabaseTransaction,
    q: {
      bloodGroup: string;
      units: number;
      hospitalName: string;
      hospitalPlaceId: string | null;
      location: Origin;
      neededBy: string;
      urgency: string;
      patientNote: string | null;
      contactPhone: string | null;
    },
  ): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.blood_requests
        (requester_member_id, blood_group_code, units_needed, hospital_name, hospital_place_id, location,
         needed_by, urgency_code, patient_note, contact_phone_e164)
      values
        (public.current_member_id(), ${q.bloodGroup}, ${q.units}, ${q.hospitalName},
         ${q.hospitalPlaceId}::uuid, ${point(q.location)}, ${q.neededBy}::timestamptz, ${q.urgency},
         ${q.patientNote},
         coalesce(${q.contactPhone}, (select u.phone_e164 from public.users u where u.id = public.current_user_id())))
      returning id`);
    return one(z.object({ id: z.string() }), rows)!.id;
  }

  /** The request's own area's row (RLS: open for members, the requester, staff). */
  async request(tx: DatabaseTransaction, id: string): Promise<RequestRow | undefined> {
    const rows = await tx.execute(sql`
      select r.id, r.tenant_id, r.requester_member_id, tm.user_id as requester_user_id,
             up.display_name as requester_name, r.blood_group_code, r.units_needed, r.hospital_name,
             r.patient_note, r.contact_phone_e164, r.needed_by, r.urgency_code, r.status_code, r.created_at,
             st_y(r.location::geometry) as lat, st_x(r.location::geometry) as lng
      from public.blood_requests r
      join public.tenant_members tm on tm.tenant_id = r.tenant_id and tm.id = r.requester_member_id
      left join public.user_profiles up on up.user_id = tm.user_id
      where r.id = ${id}::uuid and r.deleted_at is null`);
    return one(requestRow, rows);
  }

  /** The area a request lives in (its routes run there). */
  async requestTenant(tx: DatabaseTransaction, id: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.blood_request_tenant_of(${id}::uuid) as tenant_id`,
    );
    return one(z.object({ tenant_id: nullableText }), rows)?.tenant_id ?? undefined;
  }

  async alertCount(tx: DatabaseTransaction, requestId: string): Promise<number> {
    const rows = await tx.execute(sql`
      select count(*)::integer as n from public.blood_request_alerts where blood_request_id = ${requestId}::uuid`);
    return one(z.object({ n: z.number() }), rows)!.n;
  }

  async myRequests(tx: DatabaseTransaction, limit: number): Promise<RequestRow[]> {
    const rows = await tx.execute(sql`
      select r.id, r.tenant_id, r.requester_member_id, tm.user_id as requester_user_id,
             up.display_name as requester_name, r.blood_group_code, r.units_needed, r.hospital_name,
             r.patient_note, r.contact_phone_e164, r.needed_by, r.urgency_code, r.status_code, r.created_at,
             st_y(r.location::geometry) as lat, st_x(r.location::geometry) as lng
      from public.blood_requests r
      join public.tenant_members tm on tm.tenant_id = r.tenant_id and tm.id = r.requester_member_id
      left join public.user_profiles up on up.user_id = tm.user_id
      where r.tenant_id = public.current_tenant_id() and r.requester_member_id = public.current_member_id()
        and r.deleted_at is null
      order by r.id desc
      limit ${limit}`);
    return z.array(requestRow).parse([...rows]);
  }

  /** Staff: the area's requests, newest first (any status). */
  async areaRequests(tx: DatabaseTransaction, limit: number): Promise<RequestRow[]> {
    const rows = await tx.execute(sql`
      select r.id, r.tenant_id, r.requester_member_id, tm.user_id as requester_user_id,
             up.display_name as requester_name, r.blood_group_code, r.units_needed, r.hospital_name,
             r.patient_note, r.contact_phone_e164, r.needed_by, r.urgency_code, r.status_code, r.created_at,
             st_y(r.location::geometry) as lat, st_x(r.location::geometry) as lng
      from public.blood_requests r
      join public.tenant_members tm on tm.tenant_id = r.tenant_id and tm.id = r.requester_member_id
      left join public.user_profiles up on up.user_id = tm.user_id
      where r.tenant_id = public.current_tenant_id() and r.deleted_at is null
      order by r.id desc
      limit ${limit}`);
    return z.array(requestRow).parse([...rows]);
  }

  async closeRequest(
    tx: DatabaseTransaction,
    id: string,
    outcome: 'fulfilled' | 'cancelled',
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.blood_requests
      set status_code = ${outcome}, fulfilled_at = case when ${outcome} = 'fulfilled' then now() end
      where id = ${id}::uuid and requester_member_id = public.current_member_id() and status_code = 'open'
      returning id`);
    return [...rows].length > 0;
  }

  async removeRequest(
    tx: DatabaseTransaction,
    id: string,
    reasonCode: string,
    reasonText: string,
  ): Promise<void> {
    await tx.execute(
      sql`select public.remove_blood_request(${id}::uuid, ${reasonCode}, ${reasonText})`,
    );
  }

  async insertRequestLead(
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
      values (${q.channel}, 'blood_request', ${q.targetMemberId}::uuid, ${q.actorMemberId}::uuid,
              ${q.actorUserId}::uuid, ${q.viewerKey})`);
  }

  async alertDonors(tx: DatabaseTransaction, requestId: string): Promise<AlertRow[]> {
    const rows = await tx.execute(sql`
      select alert_id, donor_user_id, donor_tenant_id, distance_m
      from public.blood_request_alert_donors(${requestId}::uuid)`);
    return z.array(alertRow).parse([...rows]);
  }

  async requestsToAlert(tx: DatabaseTransaction, limit: number): Promise<string[]> {
    const rows = await tx.execute(sql`select id from public.blood_requests_to_alert(${limit})`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  async expireRequests(tx: DatabaseTransaction, limit: number): Promise<number> {
    const rows = await tx.execute(sql`select public.expire_blood_requests(${limit}) as n`);
    return one(z.object({ n: z.number() }), rows)!.n;
  }

  // ---- bazar ----------------------------------------------------------------------

  /** The board's items (bazar_catalogue_for, 0061): the bazar or the agricultural input board. */
  async catalogue(
    tx: DatabaseTransaction,
    tenantId: string,
    board: BazarBoardKind = 'bazar',
  ): Promise<CatalogueRow[]> {
    const rows = await tx.execute(sql`
      select commodity_id, code, name_bn, name_en, group_code, unit_code, sort_order
      from public.bazar_catalogue_for(${tenantId}::uuid, ${board})
      order by sort_order, code, unit_code`);
    return z.array(catalogueRow).parse([...rows]);
  }

  /**
   * Published prices from..to, one figure per commodity, unit and day: the
   * lowest minimum and highest maximum across the area's markets.
   */
  async dayPrices(tx: DatabaseTransaction, from: string, to: string): Promise<DayPriceRow[]> {
    const rows = await tx.execute(sql`
      select bp.commodity_id, bp.unit_code, bp.price_date::text as price_date,
             min(bp.min_price)::text as min_price, max(bp.max_price)::text as max_price
      from public.bazar_prices bp
      where bp.tenant_id = public.current_tenant_id() and bp.status_code = 'published'
        and bp.price_date between ${from}::date and ${to}::date
      group by bp.commodity_id, bp.unit_code, bp.price_date`);
    return z.array(dayPriceRow).parse([...rows]);
  }

  /** The board's last day with any price (its own commodities only: the stale flag). */
  async lastPriceDate(
    tx: DatabaseTransaction,
    board: BazarBoardKind = 'bazar',
  ): Promise<string | null> {
    const rows = await tx.execute(sql`
      select max(bp.price_date)::text as d from public.bazar_prices bp
      join public.bazar_commodities c on c.id = bp.commodity_id
      join public.commodity_groups g on g.code = c.group_code
      where bp.tenant_id = public.current_tenant_id() and bp.status_code = 'published'
        and g.board_code = ${board}`);
    return one(z.object({ d: nullableText }), rows)?.d ?? null;
  }

  async currentSponsor(tx: DatabaseTransaction, today: string): Promise<SponsorRow | undefined> {
    const rows = await tx.execute(sql`
      select s.id, s.name_bn, s.name_en, s.tagline_bn, s.link_url, s.starts_on::text as starts_on,
             s.ends_on::text as ends_on
      from public.bazar_board_sponsors s
      where s.tenant_id = public.current_tenant_id() and s.is_active
        and s.starts_on <= ${today}::date and (s.ends_on is null or s.ends_on >= ${today}::date)
      order by s.starts_on desc, s.id desc
      limit 1`);
    return one(sponsorRow, rows);
  }

  /** The latest active sponsor row (staff editing; may start in the future). */
  async latestSponsor(tx: DatabaseTransaction): Promise<SponsorRow | undefined> {
    const rows = await tx.execute(sql`
      select s.id, s.name_bn, s.name_en, s.tagline_bn, s.link_url, s.starts_on::text as starts_on,
             s.ends_on::text as ends_on
      from public.bazar_board_sponsors s
      where s.tenant_id = public.current_tenant_id() and s.is_active
      order by s.starts_on desc, s.id desc
      limit 1`);
    return one(sponsorRow, rows);
  }

  /** One sponsor slot per area: the new one replaces the active one. */
  async replaceSponsor(tx: DatabaseTransaction, input: BazarSponsorInput | null): Promise<void> {
    await tx.execute(sql`
      update public.bazar_board_sponsors set is_active = false
      where tenant_id = public.current_tenant_id() and is_active`);
    if (!input) return;
    await tx.execute(sql`
      insert into public.bazar_board_sponsors (name_bn, name_en, tagline_bn, link_url, starts_on, ends_on)
      values (${input.nameBn}, ${input.nameEn ?? null}, ${input.taglineBn ?? null}, ${input.linkUrl ?? null},
              ${input.startsOn}::date, ${input.endsOn ?? null}::date)`);
  }

  async enterPrices(
    tx: DatabaseTransaction,
    date: string,
    items: { commodity_id: string; unit_code: string; min_price: string; max_price: string }[],
  ): Promise<number> {
    const rows = await tx.execute(
      sql`select public.bazar_enter_prices(${date}::date, ${JSON.stringify(items)}::jsonb) as n`,
    );
    return one(z.object({ n: z.number() }), rows)!.n;
  }

  /** Every active commodity, with the area's choice of each. */
  async commodities(tx: DatabaseTransaction): Promise<CommodityRow[]> {
    const rows = await tx.execute(sql`
      select c.id, c.code, c.name_bn, c.name_en, c.group_code, c.default_unit_code,
             i.unit_code as selected_unit, i.sort_order as selected_sort
      from public.bazar_commodities c
      left join public.tenant_bazar_items i
        on i.commodity_id = c.id and i.tenant_id = public.current_tenant_id() and i.is_active
      where c.is_active
      order by c.sort_order, c.code`);
    return z.array(commodityRow).parse([...rows]);
  }

  /** Replaces the area's board; an empty list goes back to "every commodity". */
  async replaceCatalogue(tx: DatabaseTransaction, input: BazarCatalogueInput): Promise<void> {
    await tx.execute(
      sql`delete from public.tenant_bazar_items where tenant_id = public.current_tenant_id()`,
    );
    for (const item of input.items) {
      await tx.execute(sql`
        insert into public.tenant_bazar_items (commodity_id, unit_code, sort_order)
        values (${item.commodityId}::uuid, ${item.unitCode}, ${item.sortOrder})`);
    }
  }
}
