import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { CLAIM_STATUSES, PLACE_STATUSES, REVISION_KINDS } from './dto/places.dto';

const nullableDate = z.coerce.date().nullable();

const PLACE_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  category_id: z.string(),
  slug: z.string(),
  name_bn: z.string(),
  name_en: z.string().nullable(),
  description: z.string().nullable(),
  phones: z.array(z.string()),
  address_text: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  geo_area_id: z.string().nullable(),
  outside_boundary: z.boolean(),
  is_landmark: z.boolean(),
  landmark_radius_km: z.string().nullable(),
  source_code: z.string(),
  created_by_user_id: z.string().nullable(),
  claimed_by_member_id: z.string().nullable(),
  claim_store_id: z.string().nullable(),
  street_photo_media_id: z.string().nullable(),
  field_verified_at: nullableDate,
  status_code: z.enum(PLACE_STATUSES),
  closed_until: nullableDate,
  rating_avg: z.string().nullable(),
  rating_count: z.number(),
  deleted_at: nullableDate,
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type PlaceRow = z.infer<typeof PLACE_ROW>;

const PLACE_COLUMNS = sql`
  p.id, p.tenant_id, p.category_id, p.slug, p.name_bn, p.name_en, p.description, p.phones,
  p.address_text, st_y(p.location::geometry) as lat, st_x(p.location::geometry) as lng,
  p.geo_area_id, p.outside_boundary, p.is_landmark, p.landmark_radius_km::text as landmark_radius_km,
  p.source_code, p.created_by_user_id, p.claimed_by_member_id, p.claim_store_id,
  p.street_photo_media_id, p.field_verified_at, p.status_code, p.closed_until, p.rating_avg::text as rating_avg,
  p.rating_count, p.deleted_at, p.created_at, p.updated_at`;

const MEDIA_ROW = z.object({
  media_asset_id: z.string(),
  thumbhash: z.string().nullable(),
  variants: z.unknown(),
  status_code: z.string(),
  visibility_code: z.string(),
});
export type PlaceMediaRow = z.infer<typeof MEDIA_ROW>;

const HOURS_ROW = z.object({
  day: z.number(),
  opens: z.string(),
  closes: z.string(),
  next_day: z.boolean(),
});
export type HoursRow = z.infer<typeof HOURS_ROW>;

const REVISION_ROW = z.object({
  id: z.string(),
  kind_code: z.enum(REVISION_KINDS),
  changed_fields: z.record(z.object({ from: z.unknown(), to: z.unknown() })),
  changed_by_user_id: z.string().nullable(),
  reverts_revision_id: z.string().nullable(),
  created_at: z.coerce.date(),
});
export type RevisionRow = z.infer<typeof REVISION_ROW>;

const CLAIM_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  place_id: z.string(),
  claimant_member_id: z.string(),
  status_code: z.enum(CLAIM_STATUSES),
  evidence_codes: z.array(z.string()),
  otp_verified_phone_e164: z.string().nullable(),
  store_id: z.string().nullable(),
  rejection_reason_code: z.string().nullable(),
  claimant_note: z.string().nullable(),
  created_at: z.coerce.date(),
  reviewed_at: nullableDate,
});
export type ClaimRow = z.infer<typeof CLAIM_ROW>;

const CLAIM_COLUMNS = sql`
  c.id, c.tenant_id, c.place_id, c.claimant_member_id, c.status_code, c.evidence_codes,
  c.otp_verified_phone_e164, c.store_id, c.rejection_reason_code, c.claimant_note,
  c.created_at, c.reviewed_at`;

export interface HoursEntry {
  day: number;
  opens: string;
  closes: string;
  nextDay: boolean;
}

export interface NewPlace {
  categoryId: string;
  slug: string;
  nameBn: string;
  nameEn: string | null;
  nameTranslit: string | null;
  description: string | null;
  phones: string[];
  addressText: string | null;
  lat: number;
  lng: number;
  geoAreaId: string | null;
  outsideBoundary: boolean;
  isLandmark: boolean;
  landmarkRadiusKm: number | null;
  sourceCode: 'agent_survey' | 'user_submitted';
  streetPhotoMediaId: string | null;
  fieldVerified: boolean;
  status: 'pending_review' | 'published';
}

export interface PlacePatch {
  nameBn?: string;
  nameTranslit?: string | null;
  nameEn?: string | null;
  categoryId?: string;
  location?: { lat: number; lng: number; geoAreaId: string | null; outsideBoundary: boolean };
  phones?: string[];
  addressText?: string | null;
  description?: string | null;
  status?: string;
  isLandmark?: boolean;
  landmarkRadiusKm?: number | null;
}

export interface NewClaim {
  placeId: string;
  claimantMemberId: string;
  verificationMethod: string;
  evidenceCodes: string[];
  otpVerifiedPhone: string | null;
  note: string | null;
}

export interface ApprovedClaim {
  placeId: string;
  storeId: string;
  createdStore: boolean;
  claimantUserId: string | null;
  supersededClaimIds: string[];
  supersededUserIds: string[];
}

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * SQL for places, their revisions and claims. Every query runs under the
 * caller's RLS context; the privileged steps (revision writes, revert, claim
 * approval) are SECURITY DEFINER functions from migration 0042 that check
 * the caller themselves.
 */
@Injectable()
export class PlacesRepository {
  /** The owning tenant of a place (item_tenant_of, 0032), or undefined. */
  async tenantOf(tx: DatabaseTransaction, placeId: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.item_tenant_of('place', ${placeId}::uuid) as tenant_id`,
    );
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
      undefined
    );
  }

  /** `forUpdate` applies the UPDATE policies: a place the caller can't edit comes back empty. */
  async find(
    tx: DatabaseTransaction,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<PlaceRow | undefined> {
    const rows = await tx.execute(sql`
      select ${PLACE_COLUMNS} from public.places p
      where p.id = ${id}::uuid ${options.forUpdate ? sql`for update` : sql``}`);
    return z
      .array(PLACE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** An active place-kind category enabled in this tenant. */
  async categoryUsable(
    tx: DatabaseTransaction,
    categoryId: string,
    tenantId: string,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      select 1 from public.categories c
      join public.tenant_categories tc on tc.category_id = c.id and tc.tenant_id = ${tenantId}::uuid
      where c.id = ${categoryId}::uuid and c.kind_code = 'place' and c.is_active and tc.is_enabled`);
    return rows.length > 0;
  }

  /** The caller's own ready, unattached files of `kind` among `ids`. */
  async usableMedia(
    tx: DatabaseTransaction,
    ids: readonly string[],
    userId: string,
    kind: 'image' | 'document',
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute(sql`
      select m.id from public.media_assets m
      where m.id in (${uuidList(ids)})
        and m.uploaded_by_user_id = ${userId}::uuid
        and m.kind_code = ${kind}
        and m.status_code = 'ready'
        and m.deleted_at is null
        and not exists (select 1 from public.media_attachments a where a.media_asset_id = m.id)`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  async insert(tx: DatabaseTransaction, place: NewPlace): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.places
        (category_id, slug, name_bn, name_en, name_translit, description, phones, address_text, location,
         geo_area_id, outside_boundary, is_landmark, landmark_radius_km, source_code,
         street_photo_media_id, field_verified_at, status_code)
      values
        (${place.categoryId}::uuid, ${place.slug}, ${place.nameBn}, ${place.nameEn}, ${place.nameTranslit},
         ${place.description}, ${textArray(place.phones)}, ${place.addressText},
         public.geo_point(${place.lat}, ${place.lng}), ${place.geoAreaId}::uuid,
         ${place.outsideBoundary}, ${place.isLandmark}, ${place.landmarkRadiusKm}::numeric,
         ${place.sourceCode}, ${place.streetPhotoMediaId}::uuid,
         ${place.fieldVerified ? sql`now()` : sql`null`}, ${place.status})
      returning id`);
    return z
      .array(z.object({ id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.id;
  }

  async update(tx: DatabaseTransaction, id: string, patch: PlacePatch): Promise<void> {
    const sets: SQL[] = [];
    if (patch.nameBn !== undefined) sets.push(sql`name_bn = ${patch.nameBn}`);
    if (patch.nameTranslit !== undefined) sets.push(sql`name_translit = ${patch.nameTranslit}`);
    if (patch.nameEn !== undefined) sets.push(sql`name_en = ${patch.nameEn}`);
    if (patch.categoryId !== undefined) sets.push(sql`category_id = ${patch.categoryId}::uuid`);
    if (patch.location !== undefined) {
      sets.push(sql`location = public.geo_point(${patch.location.lat}, ${patch.location.lng})`);
      sets.push(sql`geo_area_id = ${patch.location.geoAreaId}::uuid`);
      sets.push(sql`outside_boundary = ${patch.location.outsideBoundary}`);
    }
    if (patch.phones !== undefined) sets.push(sql`phones = ${textArray(patch.phones)}`);
    if (patch.addressText !== undefined) sets.push(sql`address_text = ${patch.addressText}`);
    if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
    if (patch.status !== undefined) sets.push(sql`status_code = ${patch.status}`);
    if (patch.isLandmark !== undefined) sets.push(sql`is_landmark = ${patch.isLandmark}`);
    if (patch.landmarkRadiusKm !== undefined) {
      sets.push(sql`landmark_radius_km = ${patch.landmarkRadiusKm}::numeric`);
    }
    if (sets.length === 0) return;
    await tx.execute(
      sql`update public.places set ${sql.join(sets, sql`, `)} where id = ${id}::uuid`,
    );
  }

  /** Moderator decision on a contribution (staff UPDATE policy). */
  async setStatus(tx: DatabaseTransaction, id: string, status: string): Promise<void> {
    await tx.execute(sql`update public.places set status_code = ${status} where id = ${id}::uuid`);
  }

  async attachMedia(
    tx: DatabaseTransaction,
    owner: { placeId: string } | { placeClaimId: string },
    mediaIds: readonly string[],
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    const column = 'placeId' in owner ? sql`place_id` : sql`place_claim_id`;
    const ownerId = 'placeId' in owner ? owner.placeId : owner.placeClaimId;
    const values = mediaIds.map(
      (mediaId, index) => sql`(${mediaId}::uuid, ${ownerId}::uuid, ${index})`,
    );
    await tx.execute(sql`
      insert into public.media_attachments (media_asset_id, ${column}, sort_order)
      values ${sql.join(values, sql`, `)}`);
  }

  async photosOf(tx: DatabaseTransaction, placeId: string): Promise<PlaceMediaRow[]> {
    const rows = await tx.execute(sql`
      select a.media_asset_id, m.thumbhash, m.variants, m.status_code, m.visibility_code
      from public.media_attachments a
      join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
      where a.place_id = ${placeId}::uuid
      order by a.sort_order`);
    return z.array(MEDIA_ROW).parse([...rows]);
  }

  async hoursOf(tx: DatabaseTransaction, placeId: string): Promise<HoursRow[]> {
    const rows = await tx.execute(sql`
      select iso_day_of_week as day, to_char(opens_at, 'HH24:MI') as opens,
             to_char(closes_at, 'HH24:MI') as closes, closes_next_day as next_day
      from public.place_hours
      where place_id = ${placeId}::uuid
      order by iso_day_of_week, opens_at`);
    return z.array(HOURS_ROW).parse([...rows]);
  }

  /** The week as a revision stores it (place_hours_json, 0042). */
  async hoursJson(tx: DatabaseTransaction, placeId: string): Promise<unknown> {
    const rows = await tx.execute(sql`select public.place_hours_json(${placeId}::uuid) as hours`);
    return z
      .array(z.object({ hours: z.unknown() }))
      .length(1)
      .parse([...rows])[0]!.hours;
  }

  async replaceHours(
    tx: DatabaseTransaction,
    placeId: string,
    hours: readonly HoursEntry[],
  ): Promise<void> {
    await tx.execute(sql`delete from public.place_hours where place_id = ${placeId}::uuid`);
    if (hours.length === 0) return;
    const values = hours.map(
      (h) => sql`(${placeId}::uuid, ${h.day}, ${h.opens}::time, ${h.closes}::time, ${h.nextDay})`,
    );
    await tx.execute(sql`
      insert into public.place_hours (place_id, iso_day_of_week, opens_at, closes_at, closes_next_day)
      values ${sql.join(values, sql`, `)}`);
  }

  async recordHoursRevision(
    tx: DatabaseTransaction,
    placeId: string,
    from: unknown,
    to: unknown,
  ): Promise<void> {
    await tx.execute(sql`
      select public.record_place_hours_revision(
        ${placeId}::uuid, ${JSON.stringify(from)}::jsonb, ${JSON.stringify(to)}::jsonb)`);
  }

  async revisions(
    tx: DatabaseTransaction,
    placeId: string,
    before: string | null,
    limit: number,
  ): Promise<RevisionRow[]> {
    const rows = await tx.execute(sql`
      select id, kind_code, changed_fields, changed_by_user_id, reverts_revision_id, created_at
      from public.place_revisions
      where place_id = ${placeId}::uuid ${before ? sql`and id < ${before}::uuid` : sql``}
      order by id desc
      limit ${limit}`);
    return z.array(REVISION_ROW).parse([...rows]);
  }

  /** revert_place_revision (0042); returns the new `reverted` revision. */
  async revert(
    tx: DatabaseTransaction,
    placeId: string,
    revisionId: string,
    reasonCode: string,
    reasonText: string | null,
  ): Promise<string | null> {
    const rows = await tx.execute(sql`
      select public.revert_place_revision(
        ${placeId}::uuid, ${revisionId}::uuid, ${reasonCode}, ${reasonText}) as revision_id`);
    return z
      .array(z.object({ revision_id: z.string().nullable() }))
      .length(1)
      .parse([...rows])[0]!.revision_id;
  }

  /** Contributions waiting for a moderator, oldest first. */
  async reviewQueue(
    tx: DatabaseTransaction,
    after: string | null,
    limit: number,
  ): Promise<(PlaceRow & { photo_count: number })[]> {
    const rows = await tx.execute(sql`
      select ${PLACE_COLUMNS},
             (select count(*)::integer from public.media_attachments a where a.place_id = p.id) as photo_count
      from public.places p
      where p.status_code = 'pending_review' and p.deleted_at is null
        ${after ? sql`and p.id > ${after}::uuid` : sql``}
      order by p.id
      limit ${limit}`);
    return z.array(PLACE_ROW.extend({ photo_count: z.number() })).parse([...rows]);
  }

  /** A moderation_actions row about a place or a claim (rule 13). */
  async recordAction(
    tx: DatabaseTransaction,
    action: {
      target: { placeId: string } | { placeClaimId: string };
      actorUserId: string;
      actionCode: string;
      reasonCode: string;
      reasonText: string | null;
      evidenceRefs: Record<string, unknown>[];
    },
  ): Promise<void> {
    const placeId = 'placeId' in action.target ? action.target.placeId : null;
    const claimId = 'placeClaimId' in action.target ? action.target.placeClaimId : null;
    await tx.execute(sql`
      insert into public.moderation_actions
        (place_id, place_claim_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
      values (${placeId}::uuid, ${claimId}::uuid, ${action.actorUserId}::uuid, ${action.actionCode},
              ${action.reasonCode}, ${action.reasonText}, ${JSON.stringify(action.evidenceRefs)}::jsonb)`);
  }

  async userOfMember(tx: DatabaseTransaction, memberId: string): Promise<string | null> {
    const rows = await tx.execute(
      sql`select user_id from public.tenant_members where id = ${memberId}::uuid`,
    );
    return z.array(z.object({ user_id: z.string() })).parse([...rows])[0]?.user_id ?? null;
  }

  // ---- claims --------------------------------------------------------------

  async insertClaim(tx: DatabaseTransaction, claim: NewClaim): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.place_claims
        (place_id, claimant_member_id, verification_method_code, evidence_codes,
         otp_verified_phone_e164, otp_verified_at, claimant_note)
      values
        (${claim.placeId}::uuid, ${claim.claimantMemberId}::uuid, ${claim.verificationMethod},
         ${textArray(claim.evidenceCodes)}, ${claim.otpVerifiedPhone},
         ${claim.otpVerifiedPhone === null ? sql`null` : sql`now()`}, ${claim.note})
      returning id`);
    return z
      .array(z.object({ id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.id;
  }

  async findClaim(
    tx: DatabaseTransaction,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<ClaimRow | undefined> {
    const rows = await tx.execute(sql`
      select ${CLAIM_COLUMNS} from public.place_claims c
      where c.id = ${id}::uuid ${options.forUpdate ? sql`for update` : sql``}`);
    return z
      .array(CLAIM_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** approve_place_claim (0042): the whole approval, in the caller's transaction. */
  async approveClaim(
    tx: DatabaseTransaction,
    claimId: string,
    storeId: string | null,
    auto: boolean,
  ): Promise<ApprovedClaim> {
    const rows = await tx.execute(sql`
      select place_id, store_id, created_store, claimant_user_id, superseded_claim_ids, superseded_user_ids
      from public.approve_place_claim(${claimId}::uuid, ${storeId}::uuid, ${auto})`);
    const row = z
      .array(
        z.object({
          place_id: z.string(),
          store_id: z.string(),
          created_store: z.boolean(),
          claimant_user_id: z.string().nullable(),
          superseded_claim_ids: z.array(z.string()),
          superseded_user_ids: z.array(z.string()),
        }),
      )
      .length(1)
      .parse([...rows])[0]!;
    return {
      placeId: row.place_id,
      storeId: row.store_id,
      createdStore: row.created_store,
      claimantUserId: row.claimant_user_id,
      supersededClaimIds: row.superseded_claim_ids,
      supersededUserIds: row.superseded_user_ids,
    };
  }

  async rejectClaim(
    tx: DatabaseTransaction,
    id: string,
    decision: { reasonCode: string; note: string | null; userId: string },
  ): Promise<void> {
    await tx.execute(sql`
      update public.place_claims
      set status_code = 'rejected', rejection_reason_code = ${decision.reasonCode},
          review_note = ${decision.note}, reviewed_by_user_id = ${decision.userId}::uuid,
          reviewed_at = now()
      where id = ${id}::uuid`);
  }

  async setReviewNote(tx: DatabaseTransaction, id: string, note: string): Promise<void> {
    await tx.execute(
      sql`update public.place_claims set review_note = ${note} where id = ${id}::uuid`,
    );
  }

  /** Pending claims, oldest first, with what a moderator needs to decide. */
  async claimQueue(
    tx: DatabaseTransaction,
    after: string | null,
    limit: number,
  ): Promise<
    (ClaimRow & {
      place_name_bn: string;
      place_phones: string[];
      claimant_user_id: string | null;
      document_ids: string[];
      competing: number;
    })[]
  > {
    const rows = await tx.execute(sql`
      select ${CLAIM_COLUMNS}, p.name_bn as place_name_bn, p.phones as place_phones,
             tm.user_id as claimant_user_id,
             coalesce((select array_agg(a.media_asset_id order by a.sort_order)
                       from public.media_attachments a where a.place_claim_id = c.id), '{}') as document_ids,
             (select count(*)::integer from public.place_claims o
              where o.tenant_id = c.tenant_id and o.place_id = c.place_id
                and o.status_code = 'pending' and o.id <> c.id) as competing
      from public.place_claims c
      join public.places p on p.tenant_id = c.tenant_id and p.id = c.place_id
      left join public.tenant_members tm on tm.tenant_id = c.tenant_id and tm.id = c.claimant_member_id
      where c.status_code = 'pending' ${after ? sql`and c.id > ${after}::uuid` : sql``}
      order by c.id
      limit ${limit}`);
    return z
      .array(
        CLAIM_ROW.extend({
          place_name_bn: z.string(),
          place_phones: z.array(z.string()),
          claimant_user_id: z.string().nullable(),
          document_ids: z.array(z.string()),
          competing: z.number(),
        }),
      )
      .parse([...rows]);
  }
}

function textArray(values: readonly string[]): SQL {
  return values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;
}
