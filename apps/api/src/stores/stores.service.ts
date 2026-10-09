import { CounterCardService } from './counter-card/counter-card.service';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { normalizeBdPhone } from '../auth/phone/phone-normalizer';
import { sqlStateOf } from '../common/utils/sql-state';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { assertRangesPerDay, toRanges } from '../hours/hours.service';
import { HoursRepository } from '../hours/hours.repository';
import { LocationsService } from '../locations/locations.service';
import { parseVariants } from '../media/media.types';
import { NotificationService } from '../notifications/notification.service';
import { DuplicatesService } from '../places/duplicates.service';
import { maskPhone, OPEN_STATES, placeSlug } from '../places/place-view';
import { PlaceLikelyDuplicateException } from '../places/places.exceptions';
import { PlacesRepository } from '../places/places.repository';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { PostsRepository } from '../posts/posts.repository';
import { isStaffRole } from '../posts/post-visibility';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { TrustScoreService } from '../trust/trust-score.service';
import type {
  CreateStoreInput,
  InviteStaffInput,
  MyStores,
  StoreReviewQueue,
  StoreReviewQueueQuery,
  StaffView,
  StoreStatusInput,
  StoreStatusResult,
  StoreView,
  UpdateStoreInput,
} from './dto/stores.dto';
import { staffAction, storeCan, type StoreAction, type StoreRole } from './store-access';
import { asStoreTier, catalogLimitKey, staffLimitKey } from './store-limits';
import { storeSlugFromName, storeSlugProblem, withSlugSuffix } from './store-slug';
import {
  StoreActionForbiddenException,
  StoreAlreadyStaffException,
  StoreCategoryInvalidException,
  StoreDescriptionTooLongException,
  StoreInvitationNotFoundException,
  StoreInviteeRefusedException,
  StoreLimitReachedException,
  StoreLocationOutsideAreaException,
  StoreMediaInvalidException,
  StoreNameTooLongException,
  StoreNotActiveException,
  StoreNotFoundException,
  StorePhoneInvalidException,
  StoreReasonInvalidException,
  StoreSlugAlreadyChangedException,
  StoreSlugInvalidException,
  StoreSlugTakenException,
  StoreStaffLimitReachedException,
  StoreStaffNotFoundException,
  StoreStatusUnchangedException,
} from './stores.exceptions';
import { StoresRepository, type StorePatch, type StoreRow } from './stores.repository';

// settings-exempt: how many random tails to try for a free slug before giving up (a collision guard, not a limit)
const SLUG_ATTEMPTS = 5;
// settings-exempt: the random tail of a pin's slug, as places use (place-view.ts)
const PLACE_SLUG_SUFFIX_CHARS = 8;
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/** The moderation action a status change is (rule 13), by where the store comes from. */
function statusAction(from: string, to: string): string {
  if (to === 'suspended') return 'store_suspended';
  if (to === 'closed') return 'store_closed';
  return from === 'pending_review' ? 'approved' : 'store_reinstated';
}

/**
 * Stores (ADR 054). A store is owned by the tenant its location falls in
 * (the same rule as posts, PostOwnershipService), has one owner member and
 * optional staff (manager | editor), a map pin (its place, created with it
 * or claimed, ADR 047) and its hours (ADR 049, reused). Every write runs in
 * the store's tenant under the caller's RLS; the database enforces the same
 * lines this service checks first (store-access.ts) to answer clearly.
 */
@Injectable()
export class StoresService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: StoresRepository,
    private readonly places: PlacesRepository,
    private readonly duplicates: DuplicatesService,
    private readonly hoursRepo: HoursRepository,
    private readonly ownership: PostOwnershipService,
    private readonly posts: PostsRepository,
    private readonly locations: LocationsService,
    private readonly settings: SettingsService,
    private readonly trust: TrustScoreService,
    private readonly notifications: NotificationService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly cards: CounterCardService,
  ) {}

  // ---- create --------------------------------------------------------------

  async create(input: CreateStoreInput): Promise<StoreView> {
    const userId = this.requireUserId();
    await this.checkTexts(input.nameBn, input.nameEn, input.description);
    const phone = this.normalizePhone(input.phone, 'phone');
    const whatsapp = this.normalizePhone(input.whatsapp, 'whatsapp');
    if (input.slug !== undefined) this.checkSlug(input.slug);

    const owner = await this.ownership.resolve(input.location.lat, input.location.lng);
    const geoAreaId = await this.geoAreaAt(input.location.lat, input.location.lng);
    const nameTranslit = this.duplicates.translitOf(input.nameBn);

    // The shop may already be on the map (an agent mapped it): claim it
    // instead (ADR 047), or say it's another shop. Either way a moderator
    // sees the pair (ADR 048).
    const candidates = await this.duplicates.checkPlace(
      {
        lat: input.location.lat,
        lng: input.location.lng,
        nameBn: input.nameBn,
        nameEn: input.nameEn ?? null,
        nameTranslit,
        phones: phone ? [phone] : [],
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

    const created = await this.ownership.inTenant(
      owner.tenantId,
      'ensure',
      async ({ memberId, role }) => {
        // The same gate as a member's map contribution (ADR 047): a trusted
        // member's store and pin go live at once, anyone else's (and anything
        // beyond every buffer) waits for a moderator.
        const live =
          isStaffRole(role) ||
          role === 'agent' ||
          (!owner.needsReview && (await this.trustedEnough(owner.tenantId, memberId!)));
        const [maxPerOwner, rangesMax] = await Promise.all([
          this.settings.get('store_max_per_owner', owner.tenantId),
          this.settings.get('hours_ranges_per_day_max'),
        ]);
        if (input.hours && input.hours.length > 0) {
          assertRangesPerDay(
            input.hours.map((h) => h.day),
            rangesMax,
          );
        }

        return this.tenantDb.transaction(async (tx) => {
          if (!(await this.repo.categoryUsable(tx, input.categoryId))) {
            throw new StoreCategoryInvalidException();
          }
          const media = [input.logoMediaId, input.bannerMediaId].filter(
            (id): id is string => id !== undefined,
          );
          await this.checkMedia(tx, media, userId);
          const slug = await this.pickSlug(
            tx,
            input.slug,
            input.nameBn,
            input.nameEn ?? null,
            null,
          );

          let ids: { storeId: string; placeId: string };
          try {
            ids = await this.repo.create(tx, {
              slug,
              nameBn: input.nameBn,
              nameEn: input.nameEn ?? null,
              nameTranslit,
              description: input.description ?? null,
              categoryId: input.categoryId,
              logoMediaId: input.logoMediaId ?? null,
              coverMediaId: input.bannerMediaId ?? null,
              phone,
              whatsapp,
              addressText: input.addressText ?? null,
              lat: input.location.lat,
              lng: input.location.lng,
              geoAreaId,
              outsideBoundary: owner.outsideBoundary,
              placeSlug: placeSlug(input.nameEn, this.random(PLACE_SLUG_SUFFIX_CHARS)),
              live,
              maxPerOwner,
            });
          } catch (error) {
            const state = sqlStateOf(error);
            if (state === 'AE247') throw new StoreLimitReachedException(maxPerOwner);
            if (state === UNIQUE_VIOLATION) throw new StoreSlugTakenException();
            throw error;
          }
          if (input.hours && input.hours.length > 0) {
            await this.hoursRepo.replaceStoreWeekly(tx, ids.storeId, toRanges(input.hours));
          }
          return ids;
        });
      },
    );

    await this.duplicates.fileForPlace(owner.tenantId, created.placeId, candidates, 'create');
    return this.view(created.storeId);
  }

  // ---- read ----------------------------------------------------------------

  /** The store as its owner and staff see it: numbers, limits, staff. */
  async view(storeId: string): Promise<StoreView> {
    const tenantId = await this.tenantOf(storeId);
    return this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(
        async (tx) => {
          const row = await this.repo.find(tx, storeId);
          if (!row || row.my_role === null) throw new StoreNotFoundException();
          return this.toView(tx, row, row.my_role);
        },
        { accessMode: 'read only' },
      ),
    );
  }

  /** GET /stores/me: every store the caller owns or staffs, in any tenant, and pending invitations. */
  async mine(): Promise<MyStores> {
    this.requireUserId();
    const rows = await this.tenantDb.transaction((tx) => this.repo.myStores(tx), {
      accessMode: 'read only',
    });
    return {
      items: rows.map((r) => ({
        id: r.store_id,
        tenantId: r.tenant_id,
        slug: r.slug,
        name: { bn: r.name_bn, en: r.name_en },
        status: r.status_code,
        tier: asStoreTier(r.tier_code),
        logo: this.image(r.logo_variants, r.logo_thumbhash),
        role: r.role_code === 'manager' ? 'manager' : r.role_code === 'owner' ? 'owner' : 'editor',
        accepted: r.accepted,
        invitedAt: r.invited_at?.toISOString() ?? null,
      })),
    };
  }

  // ---- update --------------------------------------------------------------

  async update(storeId: string, input: UpdateStoreInput): Promise<StoreView> {
    const userId = this.requireUserId();
    await this.checkTexts(input.nameBn, input.nameEn ?? undefined, input.description ?? undefined);
    const phone =
      input.phone === undefined
        ? undefined
        : this.normalizePhone(input.phone ?? undefined, 'phone');
    const whatsapp =
      input.whatsapp === undefined
        ? undefined
        : this.normalizePhone(input.whatsapp ?? undefined, 'whatsapp');
    if (input.slug !== undefined) this.checkSlug(input.slug);
    const tenantId = await this.tenantOf(storeId);

    // A store's area is fixed (its tenant); a new spot must resolve to it.
    let move:
      { lat: number; lng: number; geoAreaId: string | null; outsideBoundary: boolean } | undefined;
    if (input.location) {
      const owner = await this.ownership.resolve(input.location.lat, input.location.lng);
      if (owner.tenantId !== tenantId || owner.needsReview)
        throw new StoreLocationOutsideAreaException();
      move = {
        ...input.location,
        geoAreaId: await this.geoAreaAt(input.location.lat, input.location.lng),
        outsideBoundary: owner.outsideBoundary,
      };
    }
    const rangesMax = await this.settings.get('hours_ranges_per_day_max');
    if (input.hours && input.hours.length > 0) {
      assertRangesPerDay(
        input.hours.map((h) => h.day),
        rangesMax,
      );
    }

    await this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(async (tx) => {
        // Read and authorise first: FOR UPDATE applies the UPDATE policy, which
        // hides the store from an editor (a 404 where a 403 is the answer).
        const row = await this.repo.find(tx, storeId);
        if (!row || row.my_role === null) throw new StoreNotFoundException();
        this.require(row.my_role, 'edit_settings');
        await this.repo.find(tx, storeId, { forUpdate: true });
        if (input.slug !== undefined && input.slug !== row.slug) {
          this.require(row.my_role, 'change_slug');
          if (row.slug_changed_at !== null) throw new StoreSlugAlreadyChangedException();
          if (!(await this.repo.slugAvailable(tx, input.slug, storeId)))
            throw new StoreSlugTakenException();
        }
        if (
          input.categoryId !== undefined &&
          !(await this.repo.categoryUsable(tx, input.categoryId))
        ) {
          throw new StoreCategoryInvalidException();
        }
        const newMedia = [
          input.logoMediaId !== undefined && input.logoMediaId !== row.logo_media_id
            ? input.logoMediaId
            : null,
          input.bannerMediaId !== undefined && input.bannerMediaId !== row.cover_media_id
            ? input.bannerMediaId
            : null,
        ].filter((id): id is string => id !== null);
        await this.checkMedia(tx, newMedia, userId);

        const renamed =
          input.nameBn !== undefined
            ? { nameBn: input.nameBn, nameTranslit: this.duplicates.translitOf(input.nameBn) }
            : {};
        const patch: StorePatch = {
          ...(input.slug !== undefined && input.slug !== row.slug ? { slug: input.slug } : {}),
          ...renamed,
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.logoMediaId !== undefined ? { logoMediaId: input.logoMediaId } : {}),
          ...(input.bannerMediaId !== undefined ? { coverMediaId: input.bannerMediaId } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(whatsapp !== undefined ? { whatsapp } : {}),
          ...(input.addressText !== undefined ? { addressText: input.addressText } : {}),
          ...(move ? { location: { lat: move.lat, lng: move.lng } } : {}),
        };
        try {
          if (!(await this.repo.update(tx, storeId, patch))) {
            throw new StoreActionForbiddenException('edit_settings', row.my_role);
          }
        } catch (error) {
          const state = sqlStateOf(error);
          if (state === 'AE240') throw new StoreSlugAlreadyChangedException();
          if (state === UNIQUE_VIOLATION) throw new StoreSlugTakenException();
          throw error;
        }

        // Media: the new files are attached (kept by the orphan sweep), the replaced ones let go.
        await this.repo.attachMedia(tx, storeId, newMedia);
        const replaced = [
          input.logoMediaId !== undefined && input.logoMediaId !== row.logo_media_id
            ? row.logo_media_id
            : null,
          input.bannerMediaId !== undefined && input.bannerMediaId !== row.cover_media_id
            ? row.cover_media_id
            : null,
        ].filter((id): id is string => id !== null);
        await this.repo.detachMedia(tx, storeId, replaced);

        // The pin is the store on the map: it follows the store (places_store_manager_update, 0050).
        if (row.place_id) {
          await this.places.update(tx, row.place_id, {
            ...renamed,
            ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
            ...(input.addressText !== undefined ? { addressText: input.addressText } : {}),
            ...(move ? { location: move } : {}),
          });
        }
        if (input.hours !== undefined) {
          await this.hoursRepo.replaceStoreWeekly(tx, storeId, toRanges(input.hours));
        }
      }),
    );
    return this.view(storeId);
  }

  // ---- staff ----------------------------------------------------------------

  /** Invites by phone; the invitee accepts with POST /stores/:id/staff/accept. */
  async inviteStaff(storeId: string, input: InviteStaffInput): Promise<StaffView> {
    this.requireUserId();
    const phone = normalizeBdPhone(input.phone);
    if (!phone) throw new StorePhoneInvalidException('phone');
    const tenantId = await this.tenantOf(storeId);

    const invited = await this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(async (tx) => {
        const row = await this.repo.find(tx, storeId);
        if (!row || row.my_role === null) throw new StoreNotFoundException();
        this.require(row.my_role, staffAction('invite', input.role));
        if (row.status_code !== 'active') throw new StoreNotActiveException(row.status_code);
        const max = await this.settings.get(staffLimitKey(asStoreTier(row.tier_code)), tenantId);
        try {
          const { memberId, userId } = await this.repo.inviteStaff(
            tx,
            storeId,
            phone,
            input.role,
            max,
          );
          const staff = (await this.repo.staff(tx, storeId)).find((s) => s.member_id === memberId);
          return { row, userId, staff: staff! };
        } catch (error) {
          const state = sqlStateOf(error);
          if (state === 'AE241')
            throw new StoreActionForbiddenException(staffAction('invite', input.role), row.my_role);
          if (state === 'AE242') throw new StoreNotActiveException(row.status_code);
          if (state === 'AE243') throw new StoreStaffLimitReachedException(max);
          if (state === 'AE244') throw new StoreAlreadyStaffException();
          if (state === 'AE245') throw new StoreInviteeRefusedException();
          throw error;
        }
      }),
    );

    await this.notifications.send({
      userId: invited.userId,
      type: 'store_staff_invited',
      params: { storeId, storeName: invited.row.name_bn, role: input.role },
      deepLink: '/stores/me',
      entityId: storeId,
      dedupeKey: `store_staff_invited:${storeId}:${invited.staff.member_id}`,
    });
    return this.toStaffView(invited.staff);
  }

  async acceptInvitation(storeId: string): Promise<StoreView> {
    this.requireUserId();
    const tenantId = await this.tenantOf(storeId);
    await this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      if (!memberId) throw new StoreInvitationNotFoundException();
      const accepted = await this.tenantDb.transaction((tx) =>
        this.repo.acceptInvitation(tx, storeId),
      );
      if (!accepted) throw new StoreInvitationNotFoundException();
    });
    return this.view(storeId);
  }

  /**
   * The owner removes anyone; a manager removes editors; anyone may leave
   * (or decline an invitation) by removing themselves.
   */
  async removeStaff(storeId: string, memberId: string): Promise<void> {
    this.requireUserId();
    const tenantId = await this.tenantOf(storeId);
    await this.ownership.inTenant(tenantId, 'lookup', ({ memberId: me }) =>
      this.tenantDb.transaction(async (tx) => {
        if (memberId !== me) {
          const row = await this.repo.find(tx, storeId);
          if (!row || row.my_role === null) throw new StoreNotFoundException();
          // Only those who may remove someone get to look the person up.
          this.require(row.my_role, 'remove_editor');
          const target = (await this.repo.staff(tx, storeId)).find((s) => s.member_id === memberId);
          if (!target) throw new StoreStaffNotFoundException();
          this.require(
            row.my_role,
            staffAction('remove', target.role_code === 'manager' ? 'manager' : 'editor'),
          );
        }
        if (!(await this.repo.removeStaff(tx, storeId, memberId)))
          throw new StoreStaffNotFoundException();
      }),
    );
  }

  // ---- moderation ------------------------------------------------------------

  /**
   * Moderators approve (pending_review → active), suspend, reinstate or
   * close a store. A suspended or closed store and its posts leave the feed,
   * search and the map at once (posts.store_hidden, 0050). One
   * moderation_actions row in the same transaction (rule 13).
   */
  async setStatus(storeId: string, input: StoreStatusInput): Promise<StoreStatusResult> {
    this.requireStaffContext();
    const result = await this.tenantDb.transaction(async (tx) => {
      const row = await this.repo.find(tx, storeId, { forUpdate: true });
      if (!row) throw new StoreNotFoundException();
      if (row.status_code === input.status)
        throw new StoreStatusUnchangedException(row.status_code);
      await this.repo.setStatus(tx, storeId, input.status);
      if (input.status === 'active' && row.place_id) await this.repo.publishPin(tx, row.place_id);
      try {
        await this.repo.recordModeration(tx, {
          storeId,
          actionCode: statusAction(row.status_code, input.status),
          reasonCode: input.reasonCode,
          reasonText: input.reasonText ?? null,
        });
      } catch (error) {
        if (sqlStateOf(error) === FOREIGN_KEY_VIOLATION) throw new StoreReasonInvalidException();
        throw error;
      }
      return { row, ownerUserId: await this.repo.ownerUserId(tx, storeId) };
    });

    const type =
      input.status === 'suspended'
        ? 'store_suspended'
        : input.status === 'active' && result.row.status_code === 'suspended'
          ? 'store_reinstated'
          : null;
    if (type && result.ownerUserId) {
      await this.notifications.send({
        userId: result.ownerUserId,
        type,
        params: { storeId, storeName: result.row.name_bn, reasonCode: input.reasonCode },
        deepLink: '/stores/me',
        entityId: storeId,
        // Each decision is its own notification (a store can be suspended twice).
        dedupeKey: null,
      });
    }
    return { storeId, status: input.status };
  }

  /** Stores waiting for a moderator (a member below the trust gate, or beyond every buffer). */
  async reviewQueue(query: StoreReviewQueueQuery): Promise<StoreReviewQueue> {
    this.requireStaffContext();
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('moderation_queue_page_size_default'),
      this.settings.get('moderation_queue_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const rows = await this.tenantDb.transaction(
      (tx) => this.repo.reviewQueue(tx, query.cursor ?? null, limit + 1),
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: { bn: r.name_bn, en: r.name_en },
        category:
          r.category_id && r.category_slug
            ? {
                id: r.category_id,
                slug: r.category_slug,
                name: { bn: r.category_name_bn, en: r.category_name_en },
              }
            : null,
        location: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
        ownerMemberId: r.owner_member_id,
        outsideBoundary: r.outside_boundary,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  // ---- helpers -------------------------------------------------------------

  private async toView(
    tx: DatabaseTransaction,
    row: StoreRow,
    role: StoreRole,
  ): Promise<StoreView> {
    const tier = asStoreTier(row.tier_code);
    const [staffMax, catalogMax, facts, staff] = await Promise.all([
      this.settings.get(staffLimitKey(tier), row.tenant_id),
      this.settings.get(catalogLimitKey(tier), row.tenant_id),
      this.posts.storePostingFacts(tx, row.id),
      storeCan(role, 'view_staff') ? this.repo.staff(tx, row.id) : Promise.resolve([]),
    ]);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      slug: row.slug,
      previousSlug: row.previous_slug,
      slugChangeable: role === 'owner' && row.slug_changed_at === null,
      catalogUrl: this.cards.catalogUrl(row.tenant_slug, row.slug),
      name: { bn: row.name_bn, en: row.name_en },
      description: row.description,
      category:
        row.category_id && row.category_slug
          ? {
              id: row.category_id,
              slug: row.category_slug,
              name: { bn: row.category_name_bn, en: row.category_name_en },
            }
          : null,
      logo: this.image(row.logo_variants, row.logo_thumbhash),
      banner: this.image(row.cover_variants, row.cover_thumbhash),
      phone: row.phone_e164,
      whatsapp: row.whatsapp_e164,
      addressText: row.address_text,
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
      placeId: row.place_id,
      status: row.status_code,
      tier,
      isVerified: row.is_verified,
      limits: { staff: staffMax, catalog: catalogMax },
      counts: {
        staff: staff.length,
        catalog: facts?.catalogCount ?? 0,
      },
      myRole: role,
      staff: staff.map((s) => this.toStaffView(s)),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private toStaffView(s: {
    member_id: string;
    role_code: string;
    invited_at: Date;
    accepted_at: Date | null;
    display_name: string | null;
    phone_e164: string | null;
  }): StaffView {
    return {
      memberId: s.member_id,
      displayName: s.display_name,
      phoneMasked: s.phone_e164 ? maskPhone(s.phone_e164) : null,
      role: s.role_code === 'manager' ? 'manager' : 'editor',
      accepted: s.accepted_at !== null,
      invitedAt: s.invited_at.toISOString(),
      acceptedAt: s.accepted_at?.toISOString() ?? null,
    };
  }

  /**
   * The owner's slug if free, else the name's (with a random tail when
   * taken). A chosen slug that's taken is an error; a generated one never is.
   */
  private async pickSlug(
    tx: DatabaseTransaction,
    chosen: string | undefined,
    nameBn: string,
    nameEn: string | null,
    except: string | null,
  ): Promise<string> {
    if (chosen !== undefined) {
      if (!(await this.repo.slugAvailable(tx, chosen, except))) throw new StoreSlugTakenException();
      return chosen;
    }
    const base = storeSlugFromName(nameBn, nameEn);
    if (await this.repo.slugAvailable(tx, base, except)) return base;
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const candidate = withSlugSuffix(base, () => this.random(PLACE_SLUG_SUFFIX_CHARS));
      if (await this.repo.slugAvailable(tx, candidate, except)) return candidate;
    }
    throw new StoreSlugTakenException();
  }

  private random(chars: number): string {
    return randomUUID().replace(/-/g, '').slice(0, chars);
  }

  private checkSlug(slug: string): void {
    const problem = storeSlugProblem(slug);
    if (problem) throw new StoreSlugInvalidException(problem);
  }

  /** The caller's own ready, unattached images in the store's tenant. */
  private async checkMedia(
    tx: DatabaseTransaction,
    ids: readonly string[],
    userId: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const usable = new Set(await this.places.usableMedia(tx, ids, userId, 'image'));
    const missing = ids.filter((id) => !usable.has(id));
    if (missing.length > 0) throw new StoreMediaInvalidException(missing);
  }

  private async checkTexts(
    nameBn: string | undefined,
    nameEn: string | undefined,
    description: string | undefined,
  ): Promise<void> {
    // A store's name is also its map pin's name, so the place limit applies.
    const [nameMax, descriptionMax] = await Promise.all([
      this.settings.get('place_name_max_length'),
      this.settings.get('store_description_max_length'),
    ]);
    if (nameBn !== undefined && [...nameBn].length > nameMax)
      throw new StoreNameTooLongException('nameBn', nameMax);
    if (nameEn !== undefined && [...nameEn].length > nameMax)
      throw new StoreNameTooLongException('nameEn', nameMax);
    if (description !== undefined && [...description].length > descriptionMax) {
      throw new StoreDescriptionTooLongException(descriptionMax);
    }
  }

  private normalizePhone(raw: string | undefined, field: 'phone' | 'whatsapp'): string | null {
    if (raw === undefined) return null;
    const phone = normalizeBdPhone(raw);
    if (!phone) throw new StorePhoneInvalidException(field);
    return phone;
  }

  private require(role: StoreRole, action: StoreAction): void {
    if (!storeCan(role, action)) throw new StoreActionForbiddenException(action, role);
  }

  private async trustedEnough(tenantId: string, memberId: string): Promise<boolean> {
    const [threshold, trust] = await Promise.all([
      this.settings.get('place_contribution_trust_threshold', tenantId),
      this.trust.get(tenantId, memberId),
    ]);
    return trust.score >= threshold;
  }

  private image(variants: unknown, thumbhash: string | null): StoreView['logo'] {
    const parsed = parseVariants(variants);
    return parsed ? { url: this.storage.getPublicUrl('media', parsed.card.key), thumbhash } : null;
  }

  private async tenantOf(storeId: string): Promise<string> {
    const tenantId = await this.tenantDb.transaction((tx) => this.repo.tenantOf(tx, storeId), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new StoreNotFoundException();
    return tenantId;
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
