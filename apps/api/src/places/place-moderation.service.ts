import { Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { normalizeBdPhone } from '../auth/phone/phone-normalizer';
import { sqlStateOf } from '../common/utils/sql-state';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import {
  ReportDetailsTooLongException,
  ReportLimitReachedException,
} from '../engagement/engagement.exceptions';
import { assertRangesPerDay } from '../hours/hours.service';
import { LocationsService } from '../locations/locations.service';
import { NotificationService } from '../notifications/notification.service';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { SettingsService } from '../settings/settings.service';
import { TrustScoreService } from '../trust/trust-score.service';
import type {
  ApproveSuggestionInput,
  PlaceReportDecision,
  PlaceReportDecisionInput,
  PlaceReportDecisionResult,
  PlaceReportQueuePage,
  PlaceReportResult,
  PlaceSuggestionView,
  RejectSuggestionInput,
  ReportPlaceInput,
  ReportQueueQuery,
  SuggestionChanges,
  SuggestionDecisionResult,
  SuggestionQueuePage,
  SuggestPlaceEditInput,
} from './dto/place-moderation.dto';
import type { PageQuery } from './dto/places.dto';
import { DuplicatesService, type ReportedPair } from './duplicates.service';
import { OPEN_STATES, toHoursEntries } from './place-view';
import { PlaceModerationRepository, type SuggestionRow } from './place-moderation.repository';
import {
  PlaceDuplicateTargetInvalidException,
  PlaceLocationOtherTenantException,
  PlaceNoOpenReportsException,
  PlaceNotFoundException,
  PlacePhoneInvalidException,
  PlaceReportOwnPlaceException,
  PlaceStatusLockedException,
  PlaceSuggestionLimitReachedException,
  PlaceSuggestionNoChangeException,
  PlaceSuggestionNotFoundException,
  PlaceSuggestionNotPendingException,
  PlaceSuggestionNoteTooLongException,
  PlaceSuggestionPendingExistsException,
  TooManyPlacePhonesException,
} from './places.exceptions';
import { PlacesRepository, type PlacePatch } from './places.repository';

// settings-exempt: "per day" is a rolling 24 hours (the limits themselves are settings)
const SECONDS_PER_DAY = 24 * 60 * 60;
const NO_DATA_FOUND = 'P0002';
const OWN_PLACE = 'AE201';
const SUGGESTION_PENDING = 'AE202';

/** Each decision: what happens to which open reports, and what moderation_actions says. */
const DECISIONS: Record<
  PlaceReportDecision,
  {
    action: string;
    /** null = every open report; else only reports of this reason. */
    only: string | null;
    close: 'actioned' | 'dismissed';
    resolution: string;
  }
> = {
  dismiss: { action: 'reports_dismissed', only: null, close: 'dismissed', resolution: 'no_action' },
  resolved: {
    action: 'reports_resolved',
    only: null,
    close: 'actioned',
    resolution: 'place_updated',
  },
  confirm_closed: {
    action: 'closed_confirmed',
    only: null,
    close: 'actioned',
    resolution: 'place_closed',
  },
  clear_closed_flag: {
    action: 'closed_flag_cleared',
    only: 'closed_permanently',
    close: 'dismissed',
    resolution: 'no_action',
  },
  unpublish: {
    action: 'unpublished',
    only: null,
    close: 'actioned',
    resolution: 'content_removed',
  },
};

const DECISION_REASONS: Record<Exclude<PlaceReportDecision, 'unpublish'>, string> = {
  dismiss: 'report_unfounded',
  resolved: 'info_corrected',
  confirm_closed: 'confirmed_closed',
  clear_closed_flag: 'still_open',
};

/**
 * Map-specific reporting and moderation (ADR 051).
 *
 * Reports: a member reports a place (wrong location, closed permanently,
 * duplicate, wrong information, inappropriate) through report_place(), which
 * also flags a place "possibly closed" when enough distinct members say it
 * closed (place_closed_report_threshold). A duplicate report naming the other
 * place feeds the duplicates queue. Moderators decide per place.
 *
 * Suggestions: a member proposes a location, phones or weekly hours; nothing
 * changes until a moderator approves, which applies them through the normal
 * edit path (so place_revisions records it) and credits the suggester's trust
 * score. Every report, suggestion and decision writes moderation_actions in
 * the same transaction (CLAUDE.md rule 13).
 */
@Injectable()
export class PlaceModerationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: PlaceModerationRepository,
    private readonly places: PlacesRepository,
    private readonly ownership: PostOwnershipService,
    private readonly locations: LocationsService,
    private readonly settings: SettingsService,
    private readonly trust: TrustScoreService,
    private readonly notifications: NotificationService,
    private readonly duplicates: DuplicatesService,
  ) {}

  // ---- reports -------------------------------------------------------------

  async report(placeId: string, input: ReportPlaceInput): Promise<PlaceReportResult> {
    this.requireUserId();
    const tenantId = await this.tenantOf(placeId);
    const [detailsMax, perDay] = await Promise.all([
      this.settings.get('report_details_max_length'),
      this.settings.get('reports_per_user_per_day'),
    ]);
    const text = input.text && input.text.length > 0 ? input.text : null;
    if (text !== null && [...text].length > detailsMax) {
      throw new ReportDetailsTooLongException(detailsMax);
    }
    // The other place is checked before anything is filed: a bad one refuses the report.
    let pair: ReportedPair | null = null;
    if (input.duplicateOfPlaceId) {
      if (input.duplicateOfPlaceId === placeId) {
        throw new PlaceDuplicateTargetInvalidException('not_found', null);
      }
      const scored = await this.duplicates.scoreReportedPair(
        tenantId,
        placeId,
        input.duplicateOfPlaceId,
      );
      if ('refused' in scored) {
        throw new PlaceDuplicateTargetInvalidException(
          scored.refused,
          scored.refused === 'too_far' ? scored.maxMeters : null,
        );
      }
      pair = scored;
    }

    const result = await this.ownership.inTenant(tenantId, 'ensure', () =>
      this.tenantDb.transaction(async (tx) => {
        if ((await this.repo.reportsSince(tx, SECONDS_PER_DAY)) >= perDay) {
          throw new ReportLimitReachedException(perDay);
        }
        try {
          return await this.repo.reportPlace(tx, placeId, input.reasonCode, text);
        } catch (error) {
          const state = sqlStateOf(error);
          if (state === NO_DATA_FOUND) throw new PlaceNotFoundException();
          if (state === OWN_PLACE) throw new PlaceReportOwnPlaceException();
          throw error;
        }
      }),
    );
    if (result.created && pair) await this.duplicates.fileReportedPair(pair);
    return { reportId: result.reportId, created: result.created };
  }

  async reportQueue(query: ReportQueueQuery): Promise<PlaceReportQueuePage> {
    this.requireStaffContext();
    const [limit, notesMax] = await Promise.all([
      this.pageSize(query.limit),
      this.settings.get('place_report_queue_notes_max'),
    ]);
    const rows = await this.tenantDb.transaction(
      (tx) =>
        this.repo.reportQueue(tx, query.reason ?? null, query.cursor ?? null, limit + 1, notesMax),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        placeId: r.place_id,
        nameBn: r.name_bn,
        nameEn: r.name_en,
        status: r.status_code,
        location: { lat: r.lat, lng: r.lng },
        possiblyClosed: r.possibly_closed,
        reasons: r.reasons,
        reporterCount: r.reporters,
        notes: r.notes ?? [],
        firstReportedAt: r.first_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.first_id ?? null) : null,
    };
  }

  /** A moderator's decision on a place's open reports, in one transaction with its audit row. */
  async decide(
    placeId: string,
    input: PlaceReportDecisionInput,
  ): Promise<PlaceReportDecisionResult> {
    const { tenantId, userId } = this.requireStaffContext();
    const rule = DECISIONS[input.decision];
    return this.tenantDb.transaction(async (tx) => {
      const place = await this.places.find(tx, placeId, { forUpdate: true });
      if (!place || place.tenant_id !== tenantId || place.deleted_at !== null) {
        throw new PlaceNotFoundException();
      }
      const flagged = await this.repo.possiblyClosed(tx, placeId);
      const reports = await this.repo.openReports(tx, placeId, rule.only);
      const changesStatus = input.decision === 'confirm_closed' || input.decision === 'unpublish';
      if (changesStatus && !OPEN_STATES.includes(place.status_code)) {
        throw new PlaceStatusLockedException();
      }
      // Confirming a closure needs no report (a moderator may know); the rest decide on something.
      const hasSomething =
        reports.length > 0 || (flagged && input.decision === 'clear_closed_flag');
      if (input.decision !== 'confirm_closed' && !hasSomething) {
        throw new PlaceNoOpenReportsException();
      }

      let status = place.status_code;
      if (input.decision === 'confirm_closed') status = 'permanently_closed';
      if (input.decision === 'unpublish') status = 'rejected';
      if (status !== place.status_code) await this.places.setStatus(tx, placeId, status);
      // Any decision settles the flag: closed for good, still open, or off the map.
      if (flagged) await this.repo.setPossiblyClosed(tx, placeId, false);

      await this.repo.closeReports(tx, reports, {
        status: rule.close,
        resolution: rule.resolution,
        note: input.reasonText ?? null,
        userId,
      });
      await this.repo.recordAction(tx, {
        placeId,
        actorUserId: userId,
        actionCode: rule.action,
        reasonCode:
          input.decision === 'unpublish' ? input.reasonCode! : DECISION_REASONS[input.decision],
        reasonText: input.reasonText ?? null,
        evidenceIds: reports,
      });
      return {
        placeId,
        decision: input.decision,
        status,
        possiblyClosed: false,
        reportsClosed: reports.length,
      };
    });
  }

  // ---- suggestions ---------------------------------------------------------

  async suggest(placeId: string, input: SuggestPlaceEditInput): Promise<PlaceSuggestionView> {
    this.requireUserId();
    const tenantId = await this.tenantOf(placeId);
    const [noteMax, perDay] = await Promise.all([
      this.settings.get('place_suggestion_note_max_length'),
      this.settings.get('place_suggestions_per_user_per_day'),
    ]);
    const note = input.note && input.note.length > 0 ? input.note : null;
    if (note !== null && [...note].length > noteMax) {
      throw new PlaceSuggestionNoteTooLongException(noteMax);
    }
    const changes: SuggestionChanges = {};
    if (input.location) {
      const owner = await this.ownership.resolve(input.location.lat, input.location.lng);
      if (owner.tenantId !== tenantId) throw new PlaceLocationOtherTenantException();
      changes.location = input.location;
    }
    if (input.phones) changes.phones = await this.normalizePhones(input.phones);
    if (input.hours) {
      assertRangesPerDay(
        input.hours.map((h) => h.day),
        await this.settings.get('hours_ranges_per_day_max', tenantId),
      );
      changes.hours = sortHours(input.hours);
    }

    const id = await this.ownership.inTenant(tenantId, 'ensure', () =>
      this.tenantDb.transaction(async (tx) => {
        if ((await this.repo.suggestionsSince(tx, SECONDS_PER_DAY)) >= perDay) {
          throw new PlaceSuggestionLimitReachedException(perDay);
        }
        const place = await this.places.find(tx, placeId);
        if (!place || place.deleted_at !== null) throw new PlaceNotFoundException();
        const current = currentValues(
          { lat: place.lat, lng: place.lng },
          place.phones,
          (await this.places.hoursOf(tx, placeId)).map((h) => ({
            day: h.day,
            opens: h.opens,
            closes: h.closes,
          })),
          changes,
        );
        const changed = withoutUnchanged(changes, current);
        if (Object.keys(changed).length === 0) throw new PlaceSuggestionNoChangeException();
        try {
          return await this.repo.suggest(tx, placeId, changed, current, note);
        } catch (error) {
          const state = sqlStateOf(error);
          if (state === NO_DATA_FOUND) throw new PlaceNotFoundException();
          if (state === SUGGESTION_PENDING) throw new PlaceSuggestionPendingExistsException();
          throw error;
        }
      }),
    );
    const row = await this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction((tx) => this.repo.findSuggestion(tx, id), {
        accessMode: 'read only',
      }),
    );
    if (!row) throw new PlaceSuggestionNotFoundException();
    return toSuggestionView(row);
  }

  async suggestionQueue(query: PageQuery): Promise<SuggestionQueuePage> {
    const { tenantId } = this.requireStaffContext();
    const limit = await this.pageSize(query.limit);
    const rows = await this.tenantDb.transaction(
      (tx) => this.repo.suggestionQueue(tx, query.cursor ?? null, limit + 1),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    const trust = await Promise.all(
      page.map((r) => this.trust.get(tenantId, r.suggester_member_id)),
    );
    return {
      items: page.map((r, i) => {
        const changes = r.changes as SuggestionChanges;
        return {
          id: r.id,
          placeId: r.place_id,
          placeNameBn: r.place_name_bn,
          placeNameEn: r.place_name_en,
          changes,
          current: currentValues(
            { lat: r.place_lat, lng: r.place_lng },
            r.place_phones,
            r.place_hours.map((h) => ({ day: h.day, opens: h.opens, closes: h.closes })),
            changes,
          ),
          note: r.note,
          suggesterMemberId: r.suggester_member_id,
          suggesterTrustScore: trust[i]!.score,
          createdAt: r.created_at.toISOString(),
        };
      }),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Applies the suggestion through the normal edit path, then credits the suggester. */
  async approve(id: string, input: ApproveSuggestionInput): Promise<SuggestionDecisionResult> {
    const { tenantId, userId } = this.requireStaffContext();
    const pending = await this.tenantDb.transaction((tx) => this.repo.findSuggestion(tx, id), {
      accessMode: 'read only',
    });
    if (!pending || pending.tenant_id !== tenantId) throw new PlaceSuggestionNotFoundException();
    const changes = pending.changes as SuggestionChanges;
    // Resolved outside the transaction (it reads the areas); re-checked against the tenant.
    let location: PlacePatch['location'];
    if (changes.location) {
      const owner = await this.ownership.resolve(changes.location.lat, changes.location.lng);
      if (owner.tenantId !== tenantId) throw new PlaceLocationOtherTenantException();
      location = {
        ...changes.location,
        geoAreaId: await this.geoAreaAt(changes.location.lat, changes.location.lng),
        outsideBoundary: owner.outsideBoundary,
      };
    }

    const decided = await this.tenantDb.transaction(async (tx) => {
      const row = await this.repo.findSuggestion(tx, id, { forUpdate: true });
      if (!row || row.tenant_id !== tenantId) throw new PlaceSuggestionNotFoundException();
      if (row.status_code !== 'pending') throw new PlaceSuggestionNotPendingException();
      const place = await this.places.find(tx, row.place_id, { forUpdate: true });
      if (!place || place.deleted_at !== null) throw new PlaceNotFoundException();

      await this.places.update(tx, row.place_id, {
        ...(location ? { location } : {}),
        ...(changes.phones ? { phones: changes.phones } : {}),
      });
      if (changes.hours) {
        const before = await this.places.hoursJson(tx, row.place_id);
        await this.places.replaceHours(tx, row.place_id, toHoursEntries(changes.hours));
        await this.places.recordHoursRevision(
          tx,
          row.place_id,
          before,
          await this.places.hoursJson(tx, row.place_id),
        );
      }
      await this.repo.decideSuggestion(tx, id, {
        status: 'approved',
        userId,
        reasonCode: 'meets_guidelines',
        note: input.reasonText ?? null,
      });
      await this.repo.recordAction(tx, {
        placeId: row.place_id,
        actorUserId: userId,
        actionCode: 'suggestion_approved',
        reasonCode: 'meets_guidelines',
        reasonText: input.reasonText ?? null,
        evidenceIds: [id],
      });
      return { row, placeName: place.name_bn };
    });

    // After the commit: the approved suggestion counts toward the suggester's trust.
    await this.trust.recompute(tenantId, decided.row.suggester_member_id);
    await this.notify(decided.row, decided.placeName, 'approved', null, input.reasonText ?? null);
    return { id, placeId: decided.row.place_id, status: 'approved' };
  }

  async reject(id: string, input: RejectSuggestionInput): Promise<SuggestionDecisionResult> {
    const { tenantId, userId } = this.requireStaffContext();
    const decided = await this.tenantDb.transaction(async (tx) => {
      const row = await this.repo.findSuggestion(tx, id, { forUpdate: true });
      if (!row || row.tenant_id !== tenantId) throw new PlaceSuggestionNotFoundException();
      if (row.status_code !== 'pending') throw new PlaceSuggestionNotPendingException();
      const place = await this.places.find(tx, row.place_id);
      await this.repo.decideSuggestion(tx, id, {
        status: 'rejected',
        userId,
        reasonCode: input.reasonCode,
        note: input.reasonText ?? null,
      });
      await this.repo.recordAction(tx, {
        placeId: row.place_id,
        actorUserId: userId,
        actionCode: 'suggestion_rejected',
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        evidenceIds: [id],
      });
      return { row, placeName: place?.name_bn ?? '' };
    });
    await this.notify(
      decided.row,
      decided.placeName,
      'rejected',
      input.reasonCode,
      input.reasonText ?? null,
    );
    return { id, placeId: decided.row.place_id, status: 'rejected' };
  }

  // ---- helpers -------------------------------------------------------------

  private async notify(
    row: SuggestionRow,
    placeName: string,
    outcome: 'approved' | 'rejected',
    reasonCode: string | null,
    reasonText: string | null,
  ): Promise<void> {
    const userId = await this.tenantDb.transaction(
      (tx) => this.places.userOfMember(tx, row.suggester_member_id),
      { accessMode: 'read only' },
    );
    if (!userId) return;
    await this.notifications.send({
      userId,
      type: outcome === 'approved' ? 'place_edit_approved' : 'place_edit_rejected',
      params: { placeId: row.place_id, placeName, reasonCode, reasonText },
      deepLink: `/places/${row.place_id}`,
      entityId: row.place_id,
      dedupeKey: `place_edit_${outcome}:${row.id}`,
    });
  }

  private async tenantOf(placeId: string): Promise<string> {
    const tenantId = await this.tenantDb.transaction((tx) => this.places.tenantOf(tx, placeId), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new PlaceNotFoundException();
    return tenantId;
  }

  private async normalizePhones(raw: readonly string[]): Promise<string[]> {
    const max = await this.settings.get('place_max_phones');
    const normalized = raw.map((p) => normalizeBdPhone(p));
    const invalid = raw.filter((_, i) => normalized[i] === undefined);
    if (invalid.length > 0) throw new PlacePhoneInvalidException(invalid);
    const unique = [...new Set(normalized as string[])];
    if (unique.length > max) throw new TooManyPlacePhonesException(max);
    return unique;
  }

  private async geoAreaAt(lat: number, lng: number): Promise<string | null> {
    const areas = await this.locations.areasAt(lat, lng);
    return areas.at(-1)?.id ?? null;
  }

  private async pageSize(requested: number | undefined): Promise<number> {
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('moderation_queue_page_size_default'),
      this.settings.get('moderation_queue_page_size_max'),
    ]);
    return Math.min(requested ?? pageDefault, pageMax);
  }

  private requireUserId(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }

  private requireStaffContext(): { tenantId: string; userId: string } {
    const { tenantId, userId } = this.context.require();
    if (!userId) throw new UnauthenticatedException();
    if (!tenantId) throw new TenantRequiredException();
    return { tenantId, userId };
  }
}

type Hours = NonNullable<SuggestionChanges['hours']>;

function sortHours(hours: Hours): Hours {
  return [...hours].sort((a, b) => a.day - b.day || a.opens.localeCompare(b.opens));
}

/** The place's values for the fields a suggestion touches. */
function currentValues(
  location: { lat: number; lng: number },
  phones: readonly string[],
  hours: Hours,
  changes: SuggestionChanges,
): SuggestionChanges {
  return {
    ...(changes.location ? { location } : {}),
    ...(changes.phones ? { phones: [...phones] } : {}),
    ...(changes.hours ? { hours: sortHours(hours) } : {}),
  };
}

/** Drops suggested fields that equal what the place already has. */
function withoutUnchanged(
  changes: SuggestionChanges,
  current: SuggestionChanges,
): SuggestionChanges {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: SuggestionChanges = {};
  if (changes.location && !sameLocation(changes.location, current.location)) {
    out.location = changes.location;
  }
  if (changes.phones && !same([...changes.phones].sort(), [...(current.phones ?? [])].sort())) {
    out.phones = changes.phones;
  }
  if (changes.hours && !same(changes.hours, current.hours)) out.hours = changes.hours;
  return out;
}

// settings-exempt: ~1 m at the equator (1e-5°), below GPS noise: "the same point".
const SAME_POINT_DEGREES = 0.00001;

function sameLocation(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number } | undefined,
): boolean {
  return (
    b !== undefined &&
    Math.abs(a.lat - b.lat) < SAME_POINT_DEGREES &&
    Math.abs(a.lng - b.lng) < SAME_POINT_DEGREES
  );
}

function toSuggestionView(row: SuggestionRow): PlaceSuggestionView {
  return {
    id: row.id,
    placeId: row.place_id,
    status: row.status_code,
    changes: row.changes,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}
