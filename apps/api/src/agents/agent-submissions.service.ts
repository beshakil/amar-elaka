import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { sqlStateOf } from '../common/utils/sql-state';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { assertRangesPerDay } from '../hours/hours.service';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { DuplicatesService, type ScoredPlaceCandidate } from '../places/duplicates.service';
import { PlaceModerationRepository } from '../places/place-moderation.repository';
import { currentValues, sortHours, withoutUnchanged } from '../places/place-moderation.service';
import { OPEN_STATES, placeSlug, toHoursEntries } from '../places/place-view';
import { PlacesRepository } from '../places/places.repository';
import { PlacesService } from '../places/places.service';
import { SettingsService } from '../settings/settings.service';
import { fraudFlags, type Point } from './agent-fraud';
import {
  AgentGpsTooInaccurateException,
  AgentNotActiveException,
  AgentSubmissionRefusedException,
} from './agents.exceptions';
import { AgentsRepository, type AgentRow } from './agents.repository';
import type { SubmissionInput, SubmissionResult } from './dto/agents.dto';

// settings-exempt: length of the random slug suffix — the same URL-shape choice as PlacesService.
const SLUG_SUFFIX_CHARS = 8;
// settings-exempt: unit conversion
const MS_PER_DAY = 86_400_000;
// settings-exempt: phone clocks drift; a capture "from the future" by less than this is the clock, not fraud.
const CLOCK_SKEW_MS = 5 * 60_000;
const UNIQUE_VIOLATION = '23505';
const SUGGESTION_PENDING = 'AE202';

/**
 * A field agent's captured submission arriving from the phone's queue (ADR 066).
 *
 * Exactly once: the submission's id is the phone's UUID. Every upload of it
 * takes the same advisory lock, and the transaction that creates the place,
 * the visit or the suggestion also writes the submission row. A retried or
 * doubled sync finds the row and gets the first answer; nothing is made twice.
 *
 * A likely duplicate already on the map stops a new shop before anything is
 * written (`needs_decision`): the agent says "a different shop" (it is added)
 * or "this is it" (it becomes a verification of that shop).
 *
 * A new shop waits in the places review queue (agents are paid per shop), and
 * the anti-fraud signals go on the row for the reviewer.
 */
@Injectable()
export class AgentSubmissionsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: AgentsRepository,
    private readonly settings: SettingsService,
    private readonly ownership: PostOwnershipService,
    private readonly places: PlacesService,
    private readonly placesRepo: PlacesRepository,
    private readonly suggestions: PlaceModerationRepository,
    private readonly duplicates: DuplicatesService,
  ) {}

  async submit(input: SubmissionInput): Promise<SubmissionResult> {
    const { userId, tenantId } = this.context.require();
    if (!userId || !tenantId) throw new UnauthenticatedException();
    const agent = await this.activeAgent();

    // A repeat of a stored submission: its first answer, before any other check.
    const stored = await this.tenantDb.transaction((tx) => this.repo.findSubmission(tx, input.id), {
      accessMode: 'read only',
    });
    if (stored) return this.storedResult(stored);

    await this.checkCapture(input, tenantId);
    const owner = await this.ownership.resolve(input.location.lat, input.location.lng);
    // Boundaries decide ownership: an agent earns for their own area's shops.
    if (owner.tenantId !== tenantId) throw new AgentSubmissionRefusedException('outside_area');

    const decision = input.duplicateDecision;
    const kind =
      input.kind === 'new_shop' && decision?.decision === 'same' ? 'verify_shop' : input.kind;
    const targetPlaceId =
      decision?.decision === 'same' ? decision.placeId : (input.placeId ?? null);

    let candidates: ScoredPlaceCandidate[] = [];
    let phones: string[] = [];
    if (input.phone !== undefined) phones = await this.places.normalizePhones([input.phone]);
    if (kind === 'new_shop') {
      await this.places.checkNames(input.nameBn, input.nameEn);
      candidates = await this.duplicates.checkPlace(
        {
          lat: input.location.lat,
          lng: input.location.lng,
          nameBn: input.nameBn!,
          nameEn: input.nameEn ?? null,
          nameTranslit: this.duplicates.translitOf(input.nameBn!),
          phones,
          categoryId: input.categoryId!,
          excludeId: null,
        },
        tenantId,
      );
      const shown = candidates.filter(
        (c) => c.classification === 'likely' && OPEN_STATES.includes(c.status),
      );
      if (shown.length > 0 && decision?.decision !== 'new') {
        return {
          id: input.id,
          status: 'needs_decision',
          placeId: null,
          reviewStatus: null,
          fraudFlags: [],
          candidates: shown.map((c) => ({
            placeId: c.placeId,
            nameBn: c.nameBn,
            nameEn: c.nameEn,
            location: c.location,
            distanceM: c.distanceM,
            score: c.score,
            phoneMatch: c.signals.phoneMatch,
          })),
        };
      }
    }
    const geoAreaId =
      kind === 'new_shop'
        ? await this.places.geoAreaAt(input.location.lat, input.location.lng)
        : null;
    const fraudSettings = await this.fraudSettings();

    let result: SubmissionResult;
    try {
      result = await this.tenantDb.transaction(async (tx) => {
        await this.repo.lockSubmission(tx, input.id);
        const again = await this.repo.findSubmission(tx, input.id);
        if (again) return this.storedResult(again);

        if (input.taskId && !(await this.repo.taskExists(tx, input.taskId, agent.id))) {
          throw new AgentSubmissionRefusedException('task_not_found');
        }
        const usable = new Set(
          await this.placesRepo.usableMedia(tx, input.photoIds, userId, 'image'),
        );
        if (input.photoIds.some((id) => !usable.has(id))) {
          throw new AgentSubmissionRefusedException('photos_not_ready');
        }

        const made = await this.make(
          tx,
          kind,
          input,
          agent,
          targetPlaceId,
          phones,
          owner.outsideBoundary,
          geoAreaId,
        );
        const neighbours = await this.repo.neighbours(tx, agent.id, input.capturedAt, input.id);
        const reused = await this.repo.photoReuse(
          tx,
          input.id,
          input.photoIds,
          fraudSettings.lookbackDays,
        );
        const phoneCheck = await this.repo.phoneCheckStatus(tx, input.id);
        const fraud = fraudFlags(
          {
            capturedAt: new Date(input.capturedAt),
            location: input.location,
            photo: input.photo
              ? {
                  location: input.photo.location,
                  takenAt: input.photo.takenAt ? new Date(input.photo.takenAt) : null,
                }
              : null,
            neighbours: neighbours.map((n) => ({
              capturedAt: n.captured_at,
              location: { lat: n.lat, lng: n.lng } satisfies Point,
            })),
            reusedPhotos: reused,
            phoneFailed: phoneCheck === 'failed',
          },
          fraudSettings,
        );

        await this.repo.insertSubmission(tx, {
          id: input.id,
          agentId: agent.id,
          taskId: input.taskId ?? null,
          // "It's that shop" is what it became: a verification.
          kind,
          capturedAt: input.capturedAt,
          location: input.location,
          accuracyM: input.accuracyM,
          photoLocation: input.photo?.location ?? null,
          photoTakenAt: input.photo?.takenAt ?? null,
          photoMediaIds: input.photoIds,
          payload: {
            nameBn: input.nameBn ?? null,
            nameEn: input.nameEn ?? null,
            categoryId: input.categoryId ?? null,
            businessHours: input.businessHours ?? null,
            addressText: input.addressText ?? null,
            notes: input.notes ?? null,
            hasPhone: phones.length > 0,
          },
          placeId: made.placeId,
          suggestionId: made.suggestionId,
          visitId: made.visitId,
          duplicateDecision: decision?.decision ?? null,
          duplicateOfPlaceId: decision?.decision === 'same' ? decision.placeId : null,
          fraudFlags: fraud.flags,
          fraudDetail: fraud.detail,
          phoneCheck:
            phoneCheck === 'verified' ? 'verified' : phoneCheck === 'failed' ? 'failed' : 'none',
        });
        if (input.taskId) await this.repo.completeTask(tx, input.taskId, agent.id);
        return {
          id: input.id,
          status: 'created' as const,
          placeId: made.placeId,
          reviewStatus: kind === 'verify_shop' ? ('approved' as const) : ('pending' as const),
          fraudFlags: fraud.flags,
          candidates: [],
        };
      });
    } catch (error) {
      const state = sqlStateOf(error);
      // Someone else's submission has this id (RLS hid it from the look-up).
      if (state === UNIQUE_VIOLATION) throw new AgentSubmissionRefusedException('id_taken');
      if (state === SUGGESTION_PENDING) throw new AgentSubmissionRefusedException('update_pending');
      throw error;
    }

    // Likely (overridden) and possible duplicates go to the moderators, as for any new place.
    if (kind === 'new_shop' && result.placeId && candidates.length > 0) {
      await this.duplicates.fileForPlace(tenantId, result.placeId, candidates, 'create');
    }
    return result;
  }

  /** What the submission makes, in the submission's own transaction. */
  private async make(
    tx: DatabaseTransaction,
    kind: SubmissionInput['kind'],
    input: SubmissionInput,
    agent: AgentRow,
    targetPlaceId: string | null,
    phones: string[],
    outsideBoundary: boolean,
    geoAreaId: string | null,
  ): Promise<{ placeId: string; visitId: string | null; suggestionId: string | null }> {
    const tenantId = agent.tenant_id;
    const visit = (placeId: string, purpose: 'onboarding' | 'verification' | 'info_update') =>
      this.repo.insertVisit(tx, {
        agentId: agent.id,
        placeId,
        purpose,
        outcome: purpose === 'verification' ? 'verified' : 'submitted',
        visitedAt: input.capturedAt,
        location: input.location,
        accuracyM: input.accuracyM,
        notes: input.notes ?? null,
        clientVisitId: input.id,
      });

    if (kind === 'new_shop') {
      if (!(await this.placesRepo.categoryUsable(tx, input.categoryId!, tenantId))) {
        throw new AgentSubmissionRefusedException('category_invalid');
      }
      const [front, ...rest] = input.photoIds;
      const placeId = await this.placesRepo.insert(tx, {
        categoryId: input.categoryId!,
        slug: placeSlug(input.nameEn, randomUUID().replace(/-/g, '').slice(0, SLUG_SUFFIX_CHARS)),
        nameBn: input.nameBn!,
        nameEn: input.nameEn ?? null,
        nameTranslit: this.duplicates.translitOf(input.nameBn!),
        description: null,
        phones,
        addressText: input.addressText ?? null,
        lat: input.location.lat,
        lng: input.location.lng,
        geoAreaId,
        outsideBoundary,
        isLandmark: false,
        landmarkRadiusKm: null,
        sourceCode: 'agent_survey',
        // The shop front is the street photo; the others are the gallery.
        streetPhotoMediaId: front ?? null,
        fieldVerified: true,
        // Paid per shop: a person approves it (the places review queue).
        status: 'pending_review',
      });
      await this.placesRepo.attachMedia(tx, { placeId }, [...rest, ...(front ? [front] : [])]);
      if (input.businessHours && input.businessHours.length > 0) {
        assertRangesPerDay(
          input.businessHours.map((h) => h.day),
          await this.settings.get('hours_ranges_per_day_max', tenantId),
        );
        await this.placesRepo.replaceHours(tx, placeId, toHoursEntries(input.businessHours));
        await this.placesRepo.recordHoursRevision(
          tx,
          placeId,
          [],
          await this.placesRepo.hoursJson(tx, placeId),
        );
      }
      return { placeId, visitId: await visit(placeId, 'onboarding'), suggestionId: null };
    }

    const place = targetPlaceId ? await this.placesRepo.find(tx, targetPlaceId) : undefined;
    if (!place || place.deleted_at !== null)
      throw new AgentSubmissionRefusedException('place_not_found');

    if (kind === 'verify_shop') {
      await this.repo.markFieldVerified(tx, place.id);
      return {
        placeId: place.id,
        visitId: await visit(place.id, 'verification'),
        suggestionId: null,
      };
    }

    // update_info: what the agent found, as an edit suggestion (the existing queue).
    const changes: { phones?: string[]; hours?: ReturnType<typeof sortHours> } = {};
    if (phones.length > 0) changes.phones = phones;
    if (input.businessHours) {
      assertRangesPerDay(
        input.businessHours.map((h) => h.day),
        await this.settings.get('hours_ranges_per_day_max', tenantId),
      );
      changes.hours = sortHours(input.businessHours);
    }
    const current = currentValues(
      { lat: place.lat, lng: place.lng },
      place.phones,
      (await this.placesRepo.hoursOf(tx, place.id)).map((h) => ({
        day: h.day,
        opens: h.opens,
        closes: h.closes,
      })),
      changes,
    );
    const changed = withoutUnchanged(changes, current);
    if (Object.keys(changed).length === 0)
      throw new AgentSubmissionRefusedException('nothing_to_update');
    const suggestionId = await this.suggestions.suggest(
      tx,
      place.id,
      changed,
      current,
      input.notes ?? null,
    );
    return { placeId: place.id, visitId: await visit(place.id, 'info_update'), suggestionId };
  }

  private storedResult(stored: {
    id: string;
    kind_code: string;
    place_id: string | null;
    fraud_flags: string[];
  }): SubmissionResult {
    return {
      id: stored.id,
      status: 'created',
      placeId: stored.place_id,
      reviewStatus: null,
      fraudFlags: stored.fraud_flags,
      candidates: [],
    };
  }

  /** Accuracy, age and photo count — the phone checks these too; the API decides. */
  private async checkCapture(input: SubmissionInput, tenantId: string): Promise<void> {
    const [minAccuracy, maxAgeDays, photosMax] = await Promise.all([
      this.settings.get('agent_min_gps_accuracy_m', tenantId),
      this.settings.get('agent_capture_max_age_days', tenantId),
      this.settings.get('agent_capture_photos_max'),
    ]);
    if (input.accuracyM > minAccuracy) throw new AgentGpsTooInaccurateException(minAccuracy);
    const at = new Date(input.capturedAt).getTime();
    if (at > Date.now() + CLOCK_SKEW_MS) throw new AgentSubmissionRefusedException('in_future');
    if (Date.now() - at > maxAgeDays * MS_PER_DAY)
      throw new AgentSubmissionRefusedException('too_old');
    if (input.photoIds.length > photosMax)
      throw new AgentSubmissionRefusedException('too_many_photos');
  }

  private async fraudSettings() {
    const tenantId = this.context.require().tenantId!;
    const [photoFixMaxM, photoAgeMaxMinutes, maxSpeedKmh, minSecondsBetween, lookbackDays] =
      await Promise.all([
        this.settings.get('agent_fraud_photo_fix_max_m', tenantId),
        this.settings.get('agent_fraud_photo_age_max_minutes', tenantId),
        this.settings.get('agent_fraud_max_speed_kmh', tenantId),
        this.settings.get('agent_fraud_min_seconds_between', tenantId),
        this.settings.get('agent_fraud_photo_lookback_days'),
      ]);
    return { photoFixMaxM, photoAgeMaxMinutes, maxSpeedKmh, minSecondsBetween, lookbackDays };
  }

  private async activeAgent(): Promise<AgentRow> {
    const agent = await this.tenantDb.transaction((tx) => this.repo.myAgent(tx), {
      accessMode: 'read only',
    });
    if (!agent || agent.status_code !== 'active') throw new AgentNotActiveException();
    return agent;
  }
}
