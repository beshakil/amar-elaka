import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { normalizeBdPhone } from '../auth/phone/phone-normalizer';
import { sqlStateOf } from '../common/utils/sql-state';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantContext, type AppRole } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { LocationsService } from '../locations/locations.service';
import { NotificationService } from '../notifications/notification.service';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { isStaffRole } from '../posts/post-visibility';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { TrustScoreService } from '../trust/trust-score.service';
import type {
  CreatePlaceInput,
  PageQuery,
  PlaceDecisionInput,
  PlaceDecisionResult,
  PlaceView,
  RevertResult,
  ReviewQueuePage,
  RevisionPage,
  UpdatePlaceInput,
} from './dto/places.dto';
import { DuplicatesRepository } from './duplicates.repository';
import { DuplicatesService } from './duplicates.service';
import { OPEN_STATES, placeSlug, toHoursEntries, toPlaceView } from './place-view';
import {
  NotPlaceEditorException,
  PlaceCategoryInvalidException,
  PlaceLandmarkStaffOnlyException,
  PlaceLikelyDuplicateException,
  PlaceLocationOtherTenantException,
  PlaceMediaInvalidException,
  PlaceNameTooLongException,
  PlaceNotFoundException,
  PlaceNotPendingException,
  PlacePhoneInvalidException,
  PlaceStatusLockedException,
  RevisionNotFoundException,
  RevisionNotRevertableException,
  RevisionSupersededException,
  TooManyPlacePhonesException,
  TooManyPlacePhotosException,
} from './places.exceptions';
import { PlacesRepository, type PlacePatch, type PlaceRow } from './places.repository';

// settings-exempt: length of the random slug suffix (8 hex chars), a URL-shape choice, not behaviour.
const SLUG_SUFFIX_CHARS = 8;
const NO_DATA_FOUND = 'P0002';
const INSUFFICIENT_PRIVILEGE = '42501';
const NOTHING_TO_REVERT = 'AE221';
const REVISION_SUPERSEDED = 'AE222';

/**
 * User-contributed places (ADR 047).
 *
 * A place belongs to the tenant its location falls in (boundary + buffer,
 * the same rule as posts: PostOwnershipService); every write runs in that
 * tenant's context. Agents' and staff's contributions go live at once, a
 * member's only at place_contribution_trust_threshold or above, anything
 * beyond every buffer waits for a moderator. Every change is versioned by
 * the database (place_revisions, 0042); staff revert bad edits.
 */
@Injectable()
export class PlacesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: PlacesRepository,
    private readonly ownership: PostOwnershipService,
    private readonly locations: LocationsService,
    private readonly settings: SettingsService,
    private readonly trust: TrustScoreService,
    private readonly notifications: NotificationService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly duplicates: DuplicatesService,
    private readonly duplicatesRepo: DuplicatesRepository,
  ) {}

  // ---- contribute ----------------------------------------------------------

  async create(input: CreatePlaceInput): Promise<PlaceView> {
    const userId = this.requireUserId();
    await this.checkNames(input.nameBn, input.nameEn);
    const phones = await this.normalizePhones(input.phone === undefined ? [] : [input.phone]);
    const maxPhotos = await this.settings.get('place_max_photos');
    const photos = [...new Set(input.photos)].filter((id) => id !== input.streetPhoto);
    if (photos.length > maxPhotos) throw new TooManyPlacePhotosException(maxPhotos);

    const owner = await this.ownership.resolve(input.location.lat, input.location.lng);
    const geoAreaId = await this.geoAreaAt(input.location.lat, input.location.lng);

    // "Is this the same place?" (ADR 048): a likely duplicate that people can
    // already see holds the creation until the contributor says it isn't.
    const nameTranslit = this.duplicates.translitOf(input.nameBn);
    const candidates = await this.duplicates.checkPlace(
      {
        lat: input.location.lat,
        lng: input.location.lng,
        nameBn: input.nameBn,
        nameEn: input.nameEn ?? null,
        nameTranslit,
        phones,
        categoryId: input.categoryId,
        excludeId: null,
      },
      owner.tenantId,
    );
    const shown = candidates.filter(
      (c) => c.classification === 'likely' && OPEN_STATES.includes(c.status),
    );
    if (shown.length > 0 && !input.confirmNotDuplicate) {
      throw new PlaceLikelyDuplicateException(
        shown.map((c) => ({
          placeId: c.placeId,
          tenantId: c.tenantId,
          nameBn: c.nameBn,
          nameEn: c.nameEn,
          location: c.location,
          distanceM: c.distanceM,
          score: c.score,
          phoneMatch: c.signals.phoneMatch,
        })),
      );
    }

    const placeId = await this.ownership.inTenant(
      owner.tenantId,
      'ensure',
      async ({ memberId, role }) => {
        const wantsLandmark =
          input.isLandmark !== undefined || input.landmarkRadiusKm !== undefined;
        if (wantsLandmark && !isStaffRole(role)) throw new PlaceLandmarkStaffOnlyException();
        const live =
          isStaffRole(role) ||
          role === 'agent' ||
          (!owner.needsReview && (await this.trustedEnough(owner.tenantId, memberId!)));

        return this.tenantDb.transaction(async (tx) => {
          if (!(await this.repo.categoryUsable(tx, input.categoryId, owner.tenantId))) {
            throw new PlaceCategoryInvalidException();
          }
          const media = [...photos, ...(input.streetPhoto ? [input.streetPhoto] : [])];
          const usable = new Set(await this.repo.usableMedia(tx, media, userId, 'image'));
          const missing = media.filter((id) => !usable.has(id));
          if (missing.length > 0) throw new PlaceMediaInvalidException(missing);

          const id = await this.repo.insert(tx, {
            categoryId: input.categoryId,
            slug: placeSlug(
              input.nameEn,
              randomUUID().replace(/-/g, '').slice(0, SLUG_SUFFIX_CHARS),
            ),
            nameBn: input.nameBn,
            nameEn: input.nameEn ?? null,
            nameTranslit,
            description: input.description ?? null,
            phones,
            addressText: input.addressText ?? null,
            lat: input.location.lat,
            lng: input.location.lng,
            geoAreaId,
            outsideBoundary: owner.outsideBoundary,
            isLandmark: input.isLandmark ?? false,
            landmarkRadiusKm: input.landmarkRadiusKm ?? null,
            sourceCode: role === 'agent' ? 'agent_survey' : 'user_submitted',
            streetPhotoMediaId: input.streetPhoto ?? null,
            fieldVerified: role === 'agent',
            status: live ? 'published' : 'pending_review',
          });
          // The street photo is attached too (last): an unattached upload is an orphan.
          await this.repo.attachMedia(tx, { placeId: id }, media);
          if (input.businessHours && input.businessHours.length > 0) {
            await this.repo.replaceHours(tx, id, toHoursEntries(input.businessHours));
            await this.repo.recordHoursRevision(tx, id, [], await this.repo.hoursJson(tx, id));
          }
          return id;
        });
      },
    );
    // Likely (overridden) and possible duplicates go to the moderators.
    await this.duplicates.fileForPlace(owner.tenantId, placeId, candidates, 'create');
    return this.get(placeId);
  }

  // ---- read ----------------------------------------------------------------

  /** A merged place answers with the place it was merged into (`redirectedFrom` set). */
  async get(requestedId: string): Promise<PlaceView> {
    const id =
      (await this.tenantDb.transaction(
        (tx) => this.duplicatesRepo.redirectTarget(tx, requestedId),
        {
          accessMode: 'read only',
        },
      )) ?? requestedId;
    const tenantId = await this.tenantOf(id);
    const userId = this.context.require().userId;
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId, role }) =>
      this.tenantDb.transaction(
        async (tx) => {
          const row = await this.repo.find(tx, id);
          if (!row || row.deleted_at !== null) throw new PlaceNotFoundException();
          const [media, hours] = await Promise.all([
            this.repo.photosOf(tx, id),
            this.repo.hoursOf(tx, id),
          ]);
          return toPlaceView(this.storage, row, media, hours, {
            isMine: userId !== undefined && row.created_by_user_id === userId,
            canEdit: isEditor(row, memberId, role),
            redirectedFrom: id === requestedId ? null : requestedId,
          });
        },
        { accessMode: 'read only' },
      ),
    );
  }

  // ---- edit ----------------------------------------------------------------

  async update(id: string, input: UpdatePlaceInput): Promise<PlaceView> {
    this.requireUserId();
    const tenantId = await this.tenantOf(id);
    if (input.nameBn !== undefined || input.nameEn) {
      await this.checkNames(input.nameBn, input.nameEn ?? undefined);
    }
    const phones =
      input.phones === undefined ? undefined : await this.normalizePhones(input.phones);
    let location: PlacePatch['location'];
    if (input.location) {
      const owner = await this.ownership.resolve(input.location.lat, input.location.lng);
      if (owner.tenantId !== tenantId) throw new PlaceLocationOtherTenantException();
      location = {
        ...input.location,
        geoAreaId: await this.geoAreaAt(input.location.lat, input.location.lng),
        outsideBoundary: owner.outsideBoundary,
      };
    }

    await this.ownership.inTenant(tenantId, 'lookup', async ({ memberId, role }) => {
      const wantsLandmark = input.isLandmark !== undefined || input.landmarkRadiusKm !== undefined;
      if (wantsLandmark && !isStaffRole(role)) throw new PlaceLandmarkStaffOnlyException();

      await this.tenantDb.transaction(async (tx) => {
        // FOR UPDATE applies the UPDATE policy (staff, agents, the claimed
        // owner): a place the caller can read but not edit comes back empty.
        const row = await this.repo.find(tx, id, { forUpdate: true });
        if (!row) {
          if (await this.repo.find(tx, id)) throw new NotPlaceEditorException();
          throw new PlaceNotFoundException();
        }
        if (row.deleted_at !== null) throw new PlaceNotFoundException();
        if (!isEditor(row, memberId, role)) throw new NotPlaceEditorException();
        if (input.status !== undefined && !OPEN_STATES.includes(row.status_code)) {
          throw new PlaceStatusLockedException();
        }
        if (
          input.categoryId !== undefined &&
          !(await this.repo.categoryUsable(tx, input.categoryId, tenantId))
        ) {
          throw new PlaceCategoryInvalidException();
        }
        await this.repo.update(tx, id, {
          ...(input.nameBn !== undefined
            ? { nameBn: input.nameBn, nameTranslit: this.duplicates.translitOf(input.nameBn) }
            : {}),
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(location ? { location } : {}),
          ...(phones !== undefined ? { phones } : {}),
          ...(input.addressText !== undefined ? { addressText: input.addressText } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.isLandmark !== undefined ? { isLandmark: input.isLandmark } : {}),
          ...(input.landmarkRadiusKm !== undefined
            ? { landmarkRadiusKm: input.landmarkRadiusKm }
            : {}),
        });
        if (input.businessHours !== undefined) {
          const before = await this.repo.hoursJson(tx, id);
          await this.repo.replaceHours(tx, id, toHoursEntries(input.businessHours));
          await this.repo.recordHoursRevision(tx, id, before, await this.repo.hoursJson(tx, id));
        }
      });
    });
    return this.get(id);
  }

  // ---- history -------------------------------------------------------------

  async revisions(id: string, query: PageQuery): Promise<RevisionPage> {
    this.requireUserId();
    const tenantId = await this.tenantOf(id);
    const limit = await this.pageSize(query.limit);
    const rows = await this.ownership.inTenant(tenantId, 'lookup', async ({ memberId, role }) =>
      this.tenantDb.transaction(
        async (tx) => {
          const place = await this.repo.find(tx, id);
          if (!place) throw new PlaceNotFoundException();
          if (!isEditor(place, memberId, role)) throw new NotPlaceEditorException();
          return this.repo.revisions(tx, id, query.cursor ?? null, limit + 1);
        },
        { accessMode: 'read only' },
      ),
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind_code,
        changedFields: r.changed_fields,
        changedByUserId: r.changed_by_user_id,
        revertsRevisionId: r.reverts_revision_id,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Staff, in their own tenant: put a revision's `from` values back (revert_place_revision, 0042). */
  async revert(id: string, revisionId: string, input: PlaceDecisionInput): Promise<RevertResult> {
    const { tenantId } = this.requireStaffContext();
    if ((await this.tenantOf(id)) !== tenantId) throw new PlaceNotFoundException();
    try {
      const newRevision = await this.tenantDb.transaction((tx) =>
        this.repo.revert(tx, id, revisionId, input.reasonCode, input.reasonText ?? null),
      );
      return { placeId: id, revisionId: newRevision };
    } catch (error) {
      const state = sqlStateOf(error);
      if (state === NO_DATA_FOUND) throw new RevisionNotFoundException();
      if (state === NOTHING_TO_REVERT) throw new RevisionNotRevertableException();
      if (state === REVISION_SUPERSEDED) throw new RevisionSupersededException(detailFields(error));
      if (state === INSUFFICIENT_PRIVILEGE) throw new NotPlaceEditorException();
      throw error;
    }
  }

  // ---- moderation of contributions -----------------------------------------

  async reviewQueue(query: PageQuery): Promise<ReviewQueuePage> {
    this.requireStaffContext();
    const limit = await this.pageSize(query.limit);
    const rows = await this.tenantDb.transaction(
      (tx) => this.repo.reviewQueue(tx, query.cursor ?? null, limit + 1),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        nameBn: r.name_bn,
        nameEn: r.name_en,
        categoryId: r.category_id,
        location: { lat: r.lat, lng: r.lng },
        outsideBoundary: r.outside_boundary,
        photoCount: r.photo_count,
        createdByUserId: r.created_by_user_id,
        queuedAt: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  approve(id: string): Promise<PlaceDecisionResult> {
    return this.decide(id, 'published', {
      actionCode: 'approved',
      reasonCode: 'meets_guidelines',
      reasonText: null,
    });
  }

  reject(id: string, input: PlaceDecisionInput): Promise<PlaceDecisionResult> {
    return this.decide(id, 'rejected', {
      actionCode: 'rejected',
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? null,
    });
  }

  /** pending_review → published / rejected, with its moderation_actions row, in one transaction. */
  private async decide(
    id: string,
    to: 'published' | 'rejected',
    action: { actionCode: string; reasonCode: string; reasonText: string | null },
  ): Promise<PlaceDecisionResult> {
    const { tenantId, userId } = this.requireStaffContext();
    const place = await this.tenantDb.transaction(async (tx) => {
      const row = await this.repo.find(tx, id, { forUpdate: true });
      if (!row || row.tenant_id !== tenantId || row.deleted_at !== null) {
        throw new PlaceNotFoundException();
      }
      if (row.status_code !== 'pending_review') throw new PlaceNotPendingException();
      await this.repo.setStatus(tx, id, to);
      await this.repo.recordAction(tx, {
        target: { placeId: id },
        actorUserId: userId,
        ...action,
        evidenceRefs: [],
      });
      return row;
    });
    if (place.created_by_user_id) {
      await this.notifications.send({
        userId: place.created_by_user_id,
        type: to === 'published' ? 'place_approved' : 'place_rejected',
        params: {
          placeId: id,
          placeName: place.name_bn,
          reasonCode: to === 'published' ? null : action.reasonCode,
          reasonText: action.reasonText,
        },
        deepLink: `/places/${id}`,
        entityId: id,
        dedupeKey: `place_${to}:${id}`,
      });
    }
    return { placeId: id, status: to };
  }

  // ---- helpers -------------------------------------------------------------

  private async tenantOf(id: string): Promise<string> {
    const tenantId = await this.tenantDb.transaction((tx) => this.repo.tenantOf(tx, id), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new PlaceNotFoundException();
    return tenantId;
  }

  private async trustedEnough(tenantId: string, memberId: string): Promise<boolean> {
    const [threshold, trust] = await Promise.all([
      this.settings.get('place_contribution_trust_threshold', tenantId),
      this.trust.get(tenantId, memberId),
    ]);
    return trust.score >= threshold;
  }

  private async checkNames(nameBn: string | undefined, nameEn: string | undefined): Promise<void> {
    const max = await this.settings.get('place_name_max_length');
    if (nameBn !== undefined && [...nameBn].length > max) {
      throw new PlaceNameTooLongException('nameBn', max);
    }
    if (nameEn !== undefined && [...nameEn].length > max) {
      throw new PlaceNameTooLongException('nameEn', max);
    }
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

  private async pageSize(requested: number | undefined): Promise<number> {
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('moderation_queue_page_size_default'),
      this.settings.get('moderation_queue_page_size_max'),
    ]);
    return Math.min(requested ?? pageDefault, pageMax);
  }

  /** The most specific area at the point (areas come ordered country → ward). */
  private async geoAreaAt(lat: number, lng: number): Promise<string | null> {
    const areas = await this.locations.areasAt(lat, lng);
    return areas.at(-1)?.id ?? null;
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

/** Who may edit a place — the same people its UPDATE policy lets through. */
function isEditor(row: PlaceRow, memberId: string | undefined, role: AppRole): boolean {
  return (
    isStaffRole(role) ||
    role === 'agent' ||
    (memberId !== undefined && row.claimed_by_member_id === memberId)
  );
}

/** The comma-separated field list revert_place_revision puts in DETAIL. */
function detailFields(error: unknown): string[] {
  for (let current: unknown = error; current;) {
    if (typeof current === 'object' && 'detail' in current && typeof current.detail === 'string') {
      return current.detail.split(',').filter((f) => f !== '');
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return [];
}
