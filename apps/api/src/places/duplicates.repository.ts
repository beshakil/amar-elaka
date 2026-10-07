import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';

const PLACE_SIGNAL_ROW = z.object({
  place_id: z.string(),
  tenant_id: z.string(),
  name_bn: z.string(),
  name_en: z.string().nullable(),
  status_code: z.string(),
  lat: z.number(),
  lng: z.number(),
  distance_m: z.number(),
  name_similarity: z.number(),
  phone_match: z.boolean(),
  same_category: z.boolean().nullable(),
});
export type PlaceSignalRow = z.infer<typeof PLACE_SIGNAL_ROW>;

const STORE_SIGNAL_ROW = PLACE_SIGNAL_ROW.omit({ place_id: true, same_category: true }).extend({
  store_id: z.string(),
});
export type StoreSignalRow = z.infer<typeof STORE_SIGNAL_ROW>;

/** What a duplicate check needs to know about the entity being checked. */
export interface DuplicateProbe {
  lat: number;
  lng: number;
  nameBn: string;
  nameEn: string | null;
  nameTranslit: string | null;
  phones: readonly string[];
  /** Places only. */
  categoryId?: string | null;
  excludeId: string | null;
}

export interface SignalOptions {
  radiusM: number;
  stopwords: readonly string[];
  minNameSimilarity: number;
  limit: number;
}

export interface NewCandidate {
  entityType: 'place' | 'store';
  tenantId: string;
  entityId: string;
  candidateTenantId: string;
  candidateId: string;
  score: number;
  classification: 'likely' | 'possible';
  signals: Record<string, unknown>;
  source: 'create' | 'batch' | 'report';
}

const PROBE_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  lat: z.number(),
  lng: z.number(),
  name_bn: z.string(),
  name_en: z.string().nullable(),
  name_translit: z.string().nullable(),
  phones: z.array(z.string()),
  category_id: z.string().nullable(),
});
export type ProbeRow = z.infer<typeof PROBE_ROW>;

const PAIR_SIGNAL_ROW = z.object({
  other_tenant_id: z.string(),
  distance_m: z.number(),
  name_similarity: z.number(),
  phone_match: z.boolean(),
  same_category: z.boolean(),
});
export type PairSignalRow = z.infer<typeof PAIR_SIGNAL_ROW>;

const QUEUE_ROW = z.object({
  id: z.string(),
  entity_type_code: z.enum(['place', 'store']),
  entity_id: z.string(),
  entity_name_bn: z.string().nullable(),
  candidate_id: z.string(),
  candidate_tenant_id: z.string(),
  candidate_name_bn: z.string().nullable(),
  score: z.string(),
  classification_code: z.enum(['likely', 'possible']),
  signals: z.record(z.unknown()),
  source_code: z.enum(['create', 'batch', 'report']),
  status_code: z.enum(['open', 'merged', 'dismissed']),
  created_at: z.coerce.date(),
});
export type QueueRow = z.infer<typeof QUEUE_ROW>;

const textArray = (values: readonly string[]): SQL =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

/**
 * SQL for duplicate detection and merging (0043). The cross-tenant reads
 * (radius search, rule 10) and the merge itself are SECURITY DEFINER
 * functions that check the caller; the queue is plain RLS (staff, system).
 */
@Injectable()
export class DuplicatesRepository {
  async placeSignals(
    tx: DatabaseTransaction,
    probe: DuplicateProbe,
    options: SignalOptions,
  ): Promise<PlaceSignalRow[]> {
    const rows = await tx.execute(sql`
      select * from public.place_duplicate_signals(
        ${probe.lat}::double precision, ${probe.lng}::double precision, ${probe.nameBn}, ${probe.nameEn},
        ${probe.nameTranslit}, ${textArray(probe.phones)}, ${probe.categoryId ?? null}::uuid,
        ${probe.excludeId}::uuid, ${options.radiusM}::integer, ${textArray(options.stopwords)},
        ${options.minNameSimilarity}::real, ${options.limit}::integer)`);
    return z.array(PLACE_SIGNAL_ROW).parse([...rows]);
  }

  async storeSignals(
    tx: DatabaseTransaction,
    probe: DuplicateProbe,
    options: SignalOptions,
  ): Promise<StoreSignalRow[]> {
    const rows = await tx.execute(sql`
      select * from public.store_duplicate_signals(
        ${probe.lat}::double precision, ${probe.lng}::double precision, ${probe.nameBn}, ${probe.nameEn},
        ${probe.nameTranslit}, ${textArray(probe.phones)}, ${probe.excludeId}::uuid,
        ${options.radiusM}::integer, ${textArray(options.stopwords)},
        ${options.minNameSimilarity}::real, ${options.limit}::integer)`);
    return z.array(STORE_SIGNAL_ROW).parse([...rows]);
  }

  /** The signals between a place of this tenant and the one a duplicate report names (0046). */
  async pairSignals(
    tx: DatabaseTransaction,
    placeId: string,
    otherId: string,
    stopwords: readonly string[],
  ): Promise<PairSignalRow | undefined> {
    const rows = await tx.execute(sql`
      select other_tenant_id, distance_m, name_similarity, phone_match, same_category
      from public.place_pair_signals(${placeId}::uuid, ${otherId}::uuid, ${textArray(stopwords)})`);
    return z
      .array(PAIR_SIGNAL_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** Files pairs; one row per pair ever, so a known (or dismissed) pair is skipped. Returns how many were new. */
  async file(tx: DatabaseTransaction, candidates: readonly NewCandidate[]): Promise<number> {
    let filed = 0;
    for (const c of candidates) {
      const isPlace = c.entityType === 'place';
      const rows = await tx.execute(sql`
        insert into public.duplicate_candidates
          (tenant_id, entity_type_code, place_id, candidate_place_id, store_id, candidate_store_id,
           candidate_tenant_id, score, classification_code, signals, source_code)
        values (${c.tenantId}::uuid, ${c.entityType},
                ${isPlace ? c.entityId : null}::uuid, ${isPlace ? c.candidateId : null}::uuid,
                ${isPlace ? null : c.entityId}::uuid, ${isPlace ? null : c.candidateId}::uuid,
                ${c.candidateTenantId}::uuid, ${c.score}, ${c.classification},
                ${JSON.stringify(c.signals)}::jsonb, ${c.source})
        on conflict do nothing
        returning id`);
      filed += rows.length;
    }
    return filed;
  }

  async queue(
    tx: DatabaseTransaction,
    status: 'open' | 'merged' | 'dismissed',
    after: string | null,
    limit: number,
  ): Promise<QueueRow[]> {
    const rows = await tx.execute(sql`
      select d.id, d.entity_type_code,
             coalesce(d.place_id, d.store_id) as entity_id,
             coalesce(p.name_bn, s.name_bn) as entity_name_bn,
             coalesce(d.candidate_place_id, d.candidate_store_id) as candidate_id,
             d.candidate_tenant_id,
             coalesce(cp.name_bn, cs.name_bn) as candidate_name_bn,
             d.score::text as score, d.classification_code, d.signals, d.source_code, d.status_code,
             d.created_at
      from public.duplicate_candidates d
      left join public.places p on p.id = d.place_id
      left join public.places cp on cp.id = d.candidate_place_id
      left join public.stores s on s.id = d.store_id
      left join public.stores cs on cs.id = d.candidate_store_id
      where d.status_code = ${status} ${after ? sql`and d.id > ${after}::uuid` : sql``}
      order by d.classification_code = 'likely' desc, d.id
      limit ${limit}`);
    return z.array(QUEUE_ROW).parse([...rows]);
  }

  /** open → dismissed (staff UPDATE policy); false when there was no open row to dismiss. */
  async dismiss(tx: DatabaseTransaction, id: string, userId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.duplicate_candidates
      set status_code = 'dismissed', resolved_by_user_id = ${userId}::uuid, resolved_at = now()
      where id = ${id}::uuid and status_code = 'open'
      returning id`);
    return rows.length > 0;
  }

  async merge(
    tx: DatabaseTransaction,
    loserId: string,
    targetId: string,
    reasonCode: string,
    reasonText: string | null,
  ): Promise<string> {
    const rows = await tx.execute(sql`
      select public.merge_place(${loserId}::uuid, ${targetId}::uuid, ${reasonCode}, ${reasonText}) as merge_id`);
    return z
      .array(z.object({ merge_id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.merge_id;
  }

  async undo(tx: DatabaseTransaction, mergeId: string): Promise<string> {
    const rows = await tx.execute(
      sql`select public.undo_place_merge(${mergeId}::uuid) as place_id`,
    );
    return z
      .array(z.object({ place_id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.place_id;
  }

  async mergeInfo(
    tx: DatabaseTransaction,
    mergeId: string,
  ): Promise<{ loser: string; target: string; undoUntil: Date } | undefined> {
    const rows = await tx.execute(sql`
      select loser_place_id, target_place_id, undo_until from public.place_merges where id = ${mergeId}::uuid`);
    const row = z
      .array(
        z.object({
          loser_place_id: z.string(),
          target_place_id: z.string(),
          undo_until: z.coerce.date(),
        }),
      )
      .max(1)
      .parse([...rows])[0];
    return (
      row && { loser: row.loser_place_id, target: row.target_place_id, undoUntil: row.undo_until }
    );
  }

  /** The place a merged place now lives on (itself when not merged); undefined when none. */
  async redirectTarget(tx: DatabaseTransaction, placeId: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.place_redirect_target(${placeId}::uuid) as target`,
    );
    return (
      z.array(z.object({ target: z.string().nullable() })).parse([...rows])[0]?.target ?? undefined
    );
  }

  // ---- nightly batch (system context) ---------------------------------------

  async missingTranslit(
    tx: DatabaseTransaction,
    table: 'places' | 'stores',
    limit: number,
  ): Promise<{ id: string; name_bn: string }[]> {
    const rows = await tx.execute(sql`
      select id, name_bn from ${sql.raw(`public.${table}`)}
      where name_translit is null and deleted_at is null
      order by id limit ${limit}`);
    return z.array(z.object({ id: z.string(), name_bn: z.string() })).parse([...rows]);
  }

  async setTranslit(
    tx: DatabaseTransaction,
    table: 'places' | 'stores',
    rows: readonly { id: string; translit: string }[],
  ): Promise<void> {
    for (const row of rows) {
      await tx.execute(sql`
        update ${sql.raw(`public.${table}`)} set name_translit = ${row.translit} where id = ${row.id}::uuid`);
    }
  }

  /** Places created or changed since `since`, keyset-paged on id. */
  async recentPlaces(
    tx: DatabaseTransaction,
    since: Date,
    after: string | null,
    limit: number,
  ): Promise<ProbeRow[]> {
    const rows = await tx.execute(sql`
      select p.id, p.tenant_id, st_y(p.location::geometry) as lat, st_x(p.location::geometry) as lng,
             p.name_bn, p.name_en, p.name_translit, p.phones, p.category_id
      from public.places p
      where p.updated_at >= ${since.toISOString()}::timestamptz
        and p.deleted_at is null and p.merged_into_place_id is null and p.status_code <> 'rejected'
        ${after ? sql`and p.id > ${after}::uuid` : sql``}
      order by p.id limit ${limit}`);
    return z.array(PROBE_ROW).parse([...rows]);
  }

  /** Stores with a location created or changed since `since`. */
  async recentStores(
    tx: DatabaseTransaction,
    since: Date,
    after: string | null,
    limit: number,
  ): Promise<ProbeRow[]> {
    const rows = await tx.execute(sql`
      select s.id, s.tenant_id, st_y(s.location::geometry) as lat, st_x(s.location::geometry) as lng,
             s.name_bn, s.name_en, s.name_translit,
             array_remove(array[s.phone_e164, s.whatsapp_e164], null) as phones, null::uuid as category_id
      from public.stores s
      where s.updated_at >= ${since.toISOString()}::timestamptz
        and s.location is not null and s.deleted_at is null and s.status_code <> 'closed'
        ${after ? sql`and s.id > ${after}::uuid` : sql``}
      order by s.id limit ${limit}`);
    return z.array(PROBE_ROW).parse([...rows]);
  }
}
