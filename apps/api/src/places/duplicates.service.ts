import { Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { sqlStateOf } from '../common/utils/sql-state';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import type { JobBudget } from '../jobs/job-batches';
import { transliterate } from '../search/text/transliterate';
import { SettingsService } from '../settings/settings.service';
import type {
  DuplicatePage,
  DuplicateQuery,
  MergeResult,
  PlaceDecisionInput,
  UndoResult,
} from './dto/places.dto';
import {
  classifyDuplicate,
  duplicateScore,
  type DuplicateClass,
  type DuplicateSignals,
  type DuplicateWeights,
} from './duplicate-score';
import {
  DuplicatesRepository,
  type DuplicateProbe,
  type NewCandidate,
  type ProbeRow,
  type SignalOptions,
} from './duplicates.repository';
import {
  DuplicateCandidateNotFoundException,
  NotPlaceEditorException,
  PlaceMergeAlreadyUndoneException,
  PlaceMergeNotFoundException,
  PlaceMergeOwnersConflictException,
  PlaceMergeTargetGoneException,
  PlaceMergeUndoExpiredException,
  PlaceNotFoundException,
  PlaceNotMergeableException,
} from './places.exceptions';

// merge_place / undo_place_merge SQLSTATEs (0043).
const MERGE_ERRORS: Record<string, () => Error> = {
  P0002: () => new PlaceNotFoundException(),
  '42501': () => new NotPlaceEditorException(),
  AE230: () => new PlaceNotMergeableException(),
  AE231: () => new PlaceMergeOwnersConflictException(),
};
const UNDO_ERRORS: Record<string, () => Error> = {
  P0002: () => new PlaceMergeNotFoundException(),
  '42501': () => new NotPlaceEditorException(),
  AE232: () => new PlaceMergeUndoExpiredException(),
  AE233: () => new PlaceMergeAlreadyUndoneException(),
  AE234: () => new PlaceMergeTargetGoneException(),
};

/** One existing place that resembles the one being checked, scored. */
export interface ScoredPlaceCandidate {
  placeId: string;
  tenantId: string;
  nameBn: string;
  nameEn: string | null;
  status: string;
  location: { lat: number; lng: number };
  distanceM: number;
  score: number;
  classification: DuplicateClass;
  signals: DuplicateSignals;
}

export interface ReportedPair {
  tenantId: string;
  placeId: string;
  otherId: string;
  otherTenantId: string;
  score: number;
  classification: DuplicateClass;
  signals: DuplicateSignals;
}

/**
 * Duplicate places and stores, and the merge tool (ADR 048).
 *
 * Detection: the database finds everything within duplicate_radius_m of the
 * point in any tenant (radius, never tenant — rule 10) and measures name
 * similarity (pg_trgm on Bengali, transliterated and English name keys, minus
 * duplicate_name_stopwords), phone overlap and category; this service scores
 * and classifies (duplicate-score.ts, all weights settings). It runs on
 * create (PlacesService) and nightly for places and stores changed recently.
 * Merging and its undo are one SECURITY DEFINER function each (0043).
 */
@Injectable()
export class DuplicatesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: DuplicatesRepository,
    private readonly settings: SettingsService,
  ) {}

  /** name_translit for a Bengali name (null when nothing Latin comes out). */
  translitOf(nameBn: string): string | null {
    const value = transliterate(nameBn).trim();
    return value === '' ? null : value;
  }

  /** Existing places that resemble `probe`, scored, likely first. `tenantId` = the owning tenant (its settings). */
  async checkPlace(probe: DuplicateProbe, tenantId: string): Promise<ScoredPlaceCandidate[]> {
    const [options, weights] = await Promise.all([
      this.signalOptions(tenantId),
      this.weights(tenantId),
    ]);
    const rows = await this.tenantDb.transaction(
      (tx) => this.repo.placeSignals(tx, probe, options),
      {
        accessMode: 'read only',
      },
    );
    return rows
      .map((row) => {
        const signals: DuplicateSignals = {
          nameSimilarity: row.name_similarity,
          phoneMatch: row.phone_match,
          sameCategory: row.same_category,
          distanceM: row.distance_m,
        };
        const score = duplicateScore(signals, weights);
        const classification = classifyDuplicate(score, weights);
        return classification === null
          ? null
          : {
              placeId: row.place_id,
              tenantId: row.tenant_id,
              nameBn: row.name_bn,
              nameEn: row.name_en,
              status: row.status_code,
              location: { lat: row.lat, lng: row.lng },
              distanceM: Math.round(row.distance_m),
              score,
              classification,
              signals,
            };
      })
      .filter((c): c is ScoredPlaceCandidate => c !== null)
      .sort((a, b) => b.score - a.score);
  }

  /** Queues pairs for review, as the system of the flagged place's tenant. */
  async fileForPlace(
    tenantId: string,
    placeId: string,
    candidates: readonly ScoredPlaceCandidate[],
    source: 'create' | 'batch',
  ): Promise<number> {
    if (candidates.length === 0) return 0;
    return this.asSystem(tenantId, (tx) =>
      this.repo.file(
        tx,
        candidates.map((c) => ({
          entityType: 'place',
          tenantId,
          entityId: placeId,
          candidateTenantId: c.tenantId,
          candidateId: c.placeId,
          score: c.score,
          classification: c.classification,
          signals: { ...c.signals },
          source,
        })),
      ),
    );
  }

  /**
   * The pair a member's duplicate report names (0046), scored like any other
   * pair; a person said so, so a pair below the possible score still counts
   * as possible. Read as the system of the reported place's tenant (the other
   * place may be a neighbour's). File it with fileReportedPair() once the
   * report itself is in.
   */
  async scoreReportedPair(
    tenantId: string,
    placeId: string,
    otherId: string,
  ): Promise<ReportedPair | { refused: 'not_found' | 'too_far'; maxMeters: number }> {
    const [stopwords, maxMeters, weights] = await Promise.all([
      this.settings.get('duplicate_name_stopwords', tenantId),
      this.settings.get('duplicate_report_radius_m', tenantId),
      this.weights(tenantId),
    ]);
    const pair = await this.asSystem(tenantId, (tx) =>
      this.repo.pairSignals(tx, placeId, otherId, stopwords),
    );
    if (!pair) return { refused: 'not_found', maxMeters };
    if (pair.distance_m > maxMeters) return { refused: 'too_far', maxMeters };
    const signals: DuplicateSignals = {
      nameSimilarity: pair.name_similarity,
      phoneMatch: pair.phone_match,
      sameCategory: pair.same_category,
      distanceM: pair.distance_m,
    };
    const score = duplicateScore(signals, weights);
    return {
      tenantId,
      placeId,
      otherId,
      otherTenantId: pair.other_tenant_id,
      score,
      classification: classifyDuplicate(score, weights) ?? 'possible',
      signals,
    };
  }

  /** Queues a reported pair (source 'report'); false when the pair was already known. */
  async fileReportedPair(pair: ReportedPair): Promise<boolean> {
    const filed = await this.asSystem(pair.tenantId, (tx) =>
      this.repo.file(tx, [
        {
          entityType: 'place',
          tenantId: pair.tenantId,
          entityId: pair.placeId,
          candidateTenantId: pair.otherTenantId,
          candidateId: pair.otherId,
          score: pair.score,
          classification: pair.classification,
          signals: { ...pair.signals },
          source: 'report',
        },
      ]),
    );
    return filed > 0;
  }

  // ---- moderators ----------------------------------------------------------

  async queue(query: DuplicateQuery): Promise<DuplicatePage> {
    this.requireStaff();
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('moderation_queue_page_size_default'),
      this.settings.get('moderation_queue_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const rows = await this.tenantDb.transaction(
      (tx) => this.repo.queue(tx, query.status, query.cursor ?? null, limit + 1),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        entityType: r.entity_type_code,
        entity: { id: r.entity_id, nameBn: r.entity_name_bn },
        candidate: {
          id: r.candidate_id,
          tenantId: r.candidate_tenant_id,
          nameBn: r.candidate_name_bn,
        },
        score: Number(r.score),
        classification: r.classification_code,
        signals: r.signals,
        source: r.source_code,
        status: r.status_code,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async dismiss(id: string): Promise<void> {
    const { userId } = this.requireStaff();
    const dismissed = await this.tenantDb.transaction((tx) => this.repo.dismiss(tx, id, userId));
    if (!dismissed) throw new DuplicateCandidateNotFoundException();
  }

  async merge(loserId: string, targetId: string, input: PlaceDecisionInput): Promise<MergeResult> {
    this.requireStaff();
    try {
      return await this.tenantDb.transaction(async (tx) => {
        const mergeId = await this.repo.merge(
          tx,
          loserId,
          targetId,
          input.reasonCode,
          input.reasonText ?? null,
        );
        const info = (await this.repo.mergeInfo(tx, mergeId))!;
        return {
          mergeId,
          loserPlaceId: loserId,
          targetPlaceId: targetId,
          undoUntil: info.undoUntil.toISOString(),
        };
      });
    } catch (error) {
      throw mapped(error, MERGE_ERRORS);
    }
  }

  async undo(mergeId: string): Promise<UndoResult> {
    this.requireStaff();
    try {
      const restored = await this.tenantDb.transaction((tx) => this.repo.undo(tx, mergeId));
      return { mergeId, restoredPlaceId: restored };
    } catch (error) {
      throw mapped(error, UNDO_ERRORS);
    }
  }

  // ---- nightly batch -------------------------------------------------------

  /**
   * The nightly job (system): first name_translit for rows that lack it, then
   * every place and store created or changed within duplicate_batch_lookback_hours
   * is checked against its neighbours. Pairs already known are skipped by the
   * table's one-row-per-pair index. Stays within the job budget.
   */
  async runBatch(budget: JobBudget): Promise<{ rows: number; capped: boolean }> {
    let rows = 0;
    let batches = 0;
    const spend = () => ++batches <= budget.maxBatches;

    for (const table of ['places', 'stores'] as const) {
      for (;;) {
        if (!spend()) return { rows, capped: true };
        const missing = await this.asSystem(undefined, (tx) =>
          this.repo.missingTranslit(tx, table, budget.batchSize),
        );
        const values = missing
          .map((m) => ({ id: m.id, translit: this.translitOf(m.name_bn) ?? '' }))
          .filter((v) => v.translit !== '');
        await this.asSystem(undefined, (tx) => this.repo.setTranslit(tx, table, values));
        rows += values.length;
        // Rows whose name yields nothing Latin stay NULL; stop rather than loop on them.
        if (missing.length < budget.batchSize || values.length === 0) break;
      }
    }

    const hours = await this.settings.get('duplicate_batch_lookback_hours');
    // settings-exempt: hours → milliseconds, a unit conversion
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    for (const kind of ['place', 'store'] as const) {
      let after: string | null = null;
      for (;;) {
        if (!spend()) return { rows, capped: true };
        const probes: ProbeRow[] = await this.asSystem(undefined, (tx) =>
          kind === 'place'
            ? this.repo.recentPlaces(tx, since, after, budget.batchSize)
            : this.repo.recentStores(tx, since, after, budget.batchSize),
        );
        for (const probe of probes) rows += await this.checkAndFile(kind, probe);
        if (probes.length < budget.batchSize) break;
        after = probes.at(-1)!.id;
      }
    }
    return { rows, capped: false };
  }

  private async checkAndFile(kind: 'place' | 'store', probe: ProbeRow): Promise<number> {
    const toProbe: DuplicateProbe = {
      lat: probe.lat,
      lng: probe.lng,
      nameBn: probe.name_bn,
      nameEn: probe.name_en,
      nameTranslit: probe.name_translit,
      phones: probe.phones,
      categoryId: probe.category_id,
      excludeId: probe.id,
    };
    if (kind === 'place') {
      const candidates = await this.checkPlace(toProbe, probe.tenant_id);
      return this.fileForPlace(probe.tenant_id, probe.id, candidates, 'batch');
    }
    const [options, weights] = await Promise.all([
      this.signalOptions(probe.tenant_id),
      this.weights(probe.tenant_id),
    ]);
    const rows = await this.asSystem(probe.tenant_id, (tx) =>
      this.repo.storeSignals(tx, toProbe, options),
    );
    const candidates: NewCandidate[] = [];
    for (const row of rows) {
      const signals: DuplicateSignals = {
        nameSimilarity: row.name_similarity,
        phoneMatch: row.phone_match,
        sameCategory: null,
        distanceM: row.distance_m,
      };
      const score = duplicateScore(signals, weights);
      const classification = classifyDuplicate(score, weights);
      if (classification === null) continue;
      candidates.push({
        entityType: 'store',
        tenantId: probe.tenant_id,
        entityId: probe.id,
        candidateTenantId: row.tenant_id,
        candidateId: row.store_id,
        score,
        classification,
        signals: { ...signals },
        source: 'batch',
      });
    }
    if (candidates.length === 0) return 0;
    return this.asSystem(probe.tenant_id, (tx) => this.repo.file(tx, candidates));
  }

  // ---- helpers -------------------------------------------------------------

  private async signalOptions(tenantId: string): Promise<SignalOptions> {
    const [radiusM, stopwords, minNameSimilarity, limit] = await Promise.all([
      this.settings.get('duplicate_radius_m', tenantId),
      this.settings.get('duplicate_name_stopwords', tenantId),
      this.settings.get('duplicate_possible_score', tenantId),
      this.settings.get('duplicate_candidates_max'),
    ]);
    // Below the possible score nothing can classify (unless a phone matches,
    // which the database lets through on its own).
    return { radiusM, stopwords, minNameSimilarity, limit };
  }

  private async weights(tenantId: string): Promise<DuplicateWeights> {
    const [likelyScore, possibleScore, phoneBonus, categoryMismatchFactor] = await Promise.all([
      this.settings.get('duplicate_likely_score', tenantId),
      this.settings.get('duplicate_possible_score', tenantId),
      this.settings.get('duplicate_phone_bonus', tenantId),
      this.settings.get('duplicate_category_mismatch_factor', tenantId),
    ]);
    return { likelyScore, possibleScore, phoneBonus, categoryMismatchFactor };
  }

  private asSystem<T>(
    tenantId: string | undefined,
    work: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.context.run({ role: 'system', ...(tenantId ? { tenantId } : {}) }, () =>
      this.tenantDb.transaction(work),
    );
  }

  private requireStaff(): { tenantId: string; userId: string } {
    const { tenantId, userId } = this.context.require();
    if (!userId) throw new UnauthenticatedException();
    if (!tenantId) throw new TenantRequiredException();
    return { tenantId, userId };
  }
}

function mapped(error: unknown, table: Record<string, () => Error>): unknown {
  const make = table[sqlStateOf(error) ?? ''];
  return make ? make() : error;
}
