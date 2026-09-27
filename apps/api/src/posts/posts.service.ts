import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { FieldValidationService } from '../categories/field-validation.service';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { LocationsService } from '../locations/locations.service';
import { parseVariants } from '../media/media.types';
import {
  ModerationDecisionService,
  type ForcedReviewReason,
} from '../moderation/moderation-decision.service';
import { ModerationRepository } from '../moderation/moderation.repository';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { TrustScoreService } from '../trust/trust-score.service';
import type {
  CreatePostInput,
  MarkSoldInput,
  MyPostCounts,
  MyPostsPage,
  MyPostsQuery,
  OwnershipView,
  PostView,
  ScrubbedPostView,
  UpdatePostInput,
} from './dto/posts.dto';
import { POST_IDEMPOTENCY_STORE, type PostIdempotencyStore } from './post-idempotency.store';
import { PostOwnershipService } from './post-ownership.service';
import { isPriceDrop } from './price-drop';
import { assertTransition, type PostStatus } from './post-state-machine';
import { isStaffRole, visibilityOf, type PostViewer } from './post-visibility';
import {
  NotPostOwnerException,
  PostLimitReachedException,
  PostMediaInvalidException,
  PostMediaTenantMismatchException,
  PostNotEditableException,
  PostNotFoundException,
  PostRenewTooEarlyException,
  PostTextTooLongException,
  TooManyPostMediaException,
} from './posts.exceptions';
import {
  PostsRepository,
  type PostMediaRow,
  type PostPatch,
  type PostRow,
} from './posts.repository';

// settings-exempt: unit conversions (the durations themselves are settings)
const MS_PER_HOUR = 60 * 60 * 1_000;
// settings-exempt: see above
const MS_PER_DAY = 24 * MS_PER_HOUR;
// settings-exempt: see above
const SECONDS_PER_HOUR = 60 * 60;

type Rereviewable =
  'title' | 'description' | 'media' | 'price' | 'category' | 'fields' | 'location';

export type CreateResult = { post: PostView; replayed: boolean };

/**
 * The posts module's business rules (schema.md §4.2, ADR 005, §13.26).
 *
 * Every write runs in the post's OWNING tenant's context (PostOwnershipService)
 * inside one transaction: the row, its photos and its post.* outbox events
 * commit together or not at all. Every status change goes through
 * assertTransition() — nothing here writes status_code any other way.
 */
@Injectable()
export class PostsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: PostsRepository,
    private readonly ownership: PostOwnershipService,
    private readonly fieldValidation: FieldValidationService,
    private readonly locations: LocationsService,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(POST_IDEMPOTENCY_STORE) private readonly idempotency: PostIdempotencyStore,
    private readonly decision: ModerationDecisionService,
    private readonly moderationRepo: ModerationRepository,
    private readonly trust: TrustScoreService,
  ) {}

  // ---- ownership preview ---------------------------------------------------

  /** Which tenant a post at this point would belong to — ask before uploading photos. */
  async ownershipAt(lat: number, lng: number): Promise<OwnershipView> {
    const owner = await this.ownership.resolve(lat, lng);
    return {
      tenantId: owner.tenantId,
      resolution: owner.resolution,
      outsideBoundary: owner.outsideBoundary,
      needsReview: owner.needsReview,
    };
  }

  // ---- create --------------------------------------------------------------

  async create(input: CreatePostInput, idempotencyKey: string | undefined): Promise<CreateResult> {
    const userId = this.requireUserId();
    const ttl = (await this.settings.get('post_idempotency_ttl_hours')) * SECONDS_PER_HOUR;
    const key = idempotencyKey && `post-idem:${userId}:${idempotencyKey}`;
    const requestHash = key && hashRequest(this.context.require().tenantId, input);

    if (key && requestHash) {
      const started = await this.idempotency.begin(key, requestHash, ttl);
      if (started.kind === 'replay') {
        return { post: await this.getOwnedView(started.postId), replayed: true };
      }
    }
    try {
      const postId = await this.createPost(userId, input);
      if (key && requestHash) await this.idempotency.complete(key, requestHash, postId, ttl);
      return { post: await this.getOwnedView(postId), replayed: false };
    } catch (error) {
      if (key) await this.idempotency.release(key);
      throw error;
    }
  }

  private async createPost(userId: string, input: CreatePostInput): Promise<string> {
    const requestTenantId = this.context.require().tenantId!;
    await this.checkTextLengths(input.title, input.description);
    const owner = await this.ownership.resolve(input.location.lat, input.location.lng);
    const geoAreaId = await this.geoAreaAt(input.location.lat, input.location.lng);

    return this.ownership.inTenant(owner.tenantId, 'ensure', async ({ memberId }) => {
      // Validated in the owning tenant: the category must be enabled THERE.
      const validated = await this.fieldValidation.validate(input.categoryId, input.fields);
      const trustScore = input.submit
        ? (await this.trust.get(owner.tenantId, memberId!)).score
        : undefined;

      return this.tenantDb.transaction(async (tx) => {
        await this.repo.lockUser(tx, userId);
        await this.checkLimits(tx, { creating: true, activating: input.submit });
        const mediaIds = await this.checkMedia(tx, input.mediaIds, userId, null, {
          owningTenantId: owner.tenantId,
          requestTenantId,
        });
        // Buyers reach the seller as their profile says, unless the post says otherwise.
        const profile =
          input.contactName && input.contactPhone ? null : await this.repo.myContactDefaults(tx);
        const postId = await this.repo.insert(tx, memberId!, {
          categoryId: validated.categoryId,
          fieldSchemaId: validated.fieldSchemaId,
          title: input.title,
          description: input.description ?? null,
          fields: validated.values,
          lat: input.location.lat,
          lng: input.location.lng,
          geoAreaId,
          ownershipResolution: owner.resolution,
          outsideBoundary: owner.outsideBoundary,
          showPhone: input.showPhone,
          allowChat: input.allowChat,
          showWhatsapp: input.showWhatsapp,
          contactName: input.contactName ?? profile?.name ?? null,
          contactPhone: input.contactPhone ?? profile?.phone ?? null,
          status: 'draft',
          publishedAt: null,
          expiresAt: null,
        });
        await this.repo.replaceMedia(tx, postId, mediaIds);
        await this.repo.emit(tx, 'post.created', postId, {
          tenantId: owner.tenantId,
          actorUserId: userId,
          status: 'draft',
          categoryId: validated.categoryId,
          ownershipResolution: owner.resolution,
        });
        if (input.submit) {
          await this.applySubmission(tx, {
            id: postId,
            tenantId: owner.tenantId,
            from: 'draft',
            categoryId: validated.categoryId,
            title: input.title,
            description: input.description ?? null,
            price: priceOf(validated.values),
            ownershipResolution: owner.resolution,
            authorMemberId: memberId!,
            actorUserId: userId,
            trustScore: trustScore!,
          });
        }
        return postId;
      });
    });
  }

  // ---- read ----------------------------------------------------------------

  async get(id: string): Promise<PostView | ScrubbedPostView> {
    const tenantId = await this.ownership.tenantOf(id);
    if (!tenantId) throw new PostNotFoundException();
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId, role }) => {
      const { row, media, note } = await this.tenantDb.transaction(
        async (tx) => {
          const found = await this.repo.findById(tx, id);
          return {
            row: found,
            media: found ? await this.repo.mediaOf(tx, [id]) : [],
            // Only the author's own context can read the history (0029).
            note:
              found && found.author_member_id === memberId && hasModerationNote(found)
                ? await this.repo.moderationNote(tx, id)
                : null,
          };
        },
        { accessMode: 'read only' },
      );
      if (!row) throw new PostNotFoundException();

      const viewer: PostViewer =
        memberId !== undefined && row.author_member_id === memberId
          ? 'owner'
          : isStaffRole(role)
            ? 'staff'
            : 'public';
      const visibility = visibilityOf(
        {
          status: row.status_code,
          hiddenByOwner: row.hidden_by_owner,
          deleted: row.deleted_at !== null,
          scrubbed: row.scrubbed_at !== null,
        },
        viewer,
      );
      if (visibility === 'none') throw new PostNotFoundException();
      if (visibility === 'scrubbed') return toScrubbed(row);
      return this.toView(row, media, viewer, note);
    });
  }

  async listMine(query: MyPostsQuery): Promise<MyPostsPage> {
    this.requireUserId();
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('post_list_page_size_default'),
      this.settings.get('post_list_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const refs = await this.tenantDb.transaction(
      (tx) =>
        this.repo.myPostRefs(
          tx,
          { statuses: query.status ?? null, hidden: query.hidden ?? null },
          query.cursor ?? null,
          limit + 1,
        ),
      { accessMode: 'read only' },
    );
    const page = refs.slice(0, limit);

    const byTenant = new Map<string, string[]>();
    for (const ref of page)
      byTenant.set(ref.tenantId, [...(byTenant.get(ref.tenantId) ?? []), ref.id]);
    const views = new Map<string, PostView>();
    for (const [tenantId, ids] of byTenant) {
      await this.ownership.inTenant(tenantId, 'lookup', () =>
        this.tenantDb.transaction(
          async (tx) => {
            const rows = await this.repo.findByIds(tx, ids);
            const media = await this.repo.mediaOf(tx, ids);
            for (const row of rows) {
              const note = hasModerationNote(row)
                ? await this.repo.moderationNote(tx, row.id)
                : null;
              views.set(row.id, this.toView(row, media, 'owner', note));
            }
          },
          { accessMode: 'read only' },
        ),
      );
    }
    return {
      items: page.map((ref) => views.get(ref.id)).filter((v): v is PostView => v !== undefined),
      nextCursor: refs.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async countMine(): Promise<MyPostCounts> {
    this.requireUserId();
    const counts = await this.tenantDb.transaction((tx) => this.repo.myPostCounts(tx), {
      accessMode: 'read only',
    });
    const of = (bucket: string) => counts.get(bucket) ?? 0;
    return {
      draft: of('draft'),
      pending: of('pending'),
      live: of('live'),
      rejected: of('rejected'),
      sold: of('sold'),
      expired: of('expired'),
      removed: of('removed'),
      hidden: of('hidden'),
    };
  }

  // ---- owner actions -------------------------------------------------------

  async update(id: string, input: UpdatePostInput): Promise<PostView> {
    const userId = this.requireUserId();
    if (input.title !== undefined || input.description !== undefined) {
      await this.checkTextLengths(input.title, input.description ?? undefined);
    }
    const geoAreaId = input.location
      ? await this.geoAreaAt(input.location.lat, input.location.lng)
      : undefined;
    const rereviewFields = new Set(await this.settings.get('post_rereview_fields'));

    return this.asOwner(id, async (post, tx, scope) => {
      if (post.status_code === 'sold') throw new PostNotEditableException('status');

      const categoryId = input.categoryId ?? post.category_id;
      const fieldsChanging = input.fields !== undefined || input.categoryId !== undefined;
      // Fields are re-validated (and re-pinned to the current version) when
      // they or the category change; a title-only edit keeps the pinned version.
      const validated = fieldsChanging
        ? await this.fieldValidation.validate(categoryId, input.fields ?? post.fields)
        : undefined;

      const changed = new Set<Rereviewable>();
      const patch: PostPatch = {};
      if (input.title !== undefined && input.title !== post.title) {
        patch.title = input.title;
        changed.add('title');
      }
      if (input.description !== undefined && input.description !== post.description) {
        patch.description = input.description;
        changed.add('description');
      }
      if (validated) {
        patch.categoryId = validated.categoryId;
        patch.fieldSchemaId = validated.fieldSchemaId;
        patch.fields = validated.values;
        if (validated.categoryId !== post.category_id) changed.add('category');
        if (
          JSON.stringify(validated.values['price'] ?? null) !==
          JSON.stringify(post.fields['price'] ?? null)
        ) {
          changed.add('price');
        }
        if (JSON.stringify(validated.values) !== JSON.stringify(post.fields)) changed.add('fields');
      }
      if (input.location) {
        // A new location never moves the post to another tenant (that would
        // move its billing history, §13.26); only the point and area change.
        patch.location = input.location;
        patch.geoAreaId = geoAreaId ?? null;
        changed.add('location');
      }
      if (input.showPhone !== undefined) patch.showPhone = input.showPhone;
      if (input.allowChat !== undefined) patch.allowChat = input.allowChat;
      if (input.showWhatsapp !== undefined) patch.showWhatsapp = input.showWhatsapp;
      if (input.contactName !== undefined) patch.contactName = input.contactName;
      if (input.contactPhone !== undefined) patch.contactPhone = input.contactPhone;

      if (input.mediaIds !== undefined) {
        const current = await this.repo.mediaIdsOf(tx, id);
        if (JSON.stringify(current) !== JSON.stringify(input.mediaIds)) {
          const mediaIds = await this.checkMedia(tx, input.mediaIds, userId, id, {
            owningTenantId: post.tenant_id,
            requestTenantId: scope.requestTenantId,
          });
          await this.repo.replaceMedia(tx, id, mediaIds);
          changed.add('media');
        }
      }

      const rereview = [...changed].some((field) => rereviewFields.has(field));
      let sentBack = false;
      if (post.status_code === 'live' && rereview) {
        const policy = await this.repo.categoryPolicy(tx, post.category_id, post.tenant_id);
        const title = patch.title ?? post.title;
        const description = patch.description !== undefined ? patch.description : post.description;
        const flags = await this.decision.prefilter(tx, {
          tenantId: post.tenant_id,
          postId: id,
          authorMemberId: post.author_member_id!,
          title,
          description,
          categoryId: patch.categoryId ?? post.category_id,
          price: priceOf(patch.fields ?? post.fields),
          forced: [],
          trustScore: 0,
        });
        if (
          policy.moderationMode === 'pre' ||
          post.ownership_resolution_code === 'beyond_buffer_fallback'
        ) {
          // Pre-moderated: back to the queue before anyone sees the change.
          assertTransition('live', 'pending', 'system');
          patch.status = 'pending';
          sentBack = true;
          await this.moderationRepo.fileItem(tx, {
            postId: id,
            source: 'submission',
            reasons: ['rereview', ...flags],
            trustScore: null,
          });
        } else {
          // Post-moderated: stays live, a moderator looks after the fact.
          await this.moderationRepo.fileItem(tx, {
            postId: id,
            source: 'rereview',
            reasons: ['rereview', ...flags],
            trustScore: null,
          });
        }
      }
      await this.repo.update(tx, id, patch);
      await this.repo.emit(tx, 'post.edited', id, {
        tenantId: post.tenant_id,
        actorUserId: userId,
        changed: [...changed],
        rereview: post.status_code === 'live' && rereview,
      });
      // Price-drop groundwork (ADR 037): savers are told in week 11. Only for
      // a post buyers can still see: live, not hidden, not sent back to review.
      const newPrice = patch.fields !== undefined ? priceOf(patch.fields) : priceOf(post.fields);
      if (
        post.status_code === 'live' &&
        !sentBack &&
        !post.hidden_by_owner &&
        isPriceDrop(priceOf(post.fields), newPrice)
      ) {
        await this.repo.emit(tx, 'post.price_dropped', id, {
          tenantId: post.tenant_id,
          actorUserId: userId,
          from: priceOf(post.fields),
          to: newPrice,
          categoryId: patch.categoryId ?? post.category_id,
        });
      }
      if (sentBack) {
        await this.repo.emit(tx, 'post.submitted', id, {
          tenantId: post.tenant_id,
          actorUserId: userId,
          from: 'live',
          to: 'pending',
          reason: 'edit_rereview',
        });
      }
    });
  }

  /**
   * draft → pending, then the moderation decision (ADR 030) may take it on to
   * live; rejected/removed → pending always waits for a human.
   */
  submit(id: string): Promise<PostView> {
    const userId = this.requireUserId();
    return this.asOwner(id, async (post, tx) => {
      assertTransition(post.status_code, 'pending', 'owner');
      await this.repo.lockUser(tx, userId);
      await this.checkLimits(tx, { creating: false, activating: true });
      const trustScore = (await this.trust.get(post.tenant_id, post.author_member_id!)).score;
      await this.applySubmission(tx, {
        id,
        tenantId: post.tenant_id,
        from: post.status_code,
        categoryId: post.category_id,
        title: post.title,
        description: post.description,
        price: priceOf(post.fields),
        ownershipResolution: post.ownership_resolution_code,
        authorMemberId: post.author_member_id!,
        actorUserId: userId,
        trustScore,
      });
    });
  }

  markSold(id: string, input: MarkSoldInput): Promise<PostView> {
    const userId = this.requireUserId();
    return this.asOwner(id, async (post, tx) => {
      assertTransition(post.status_code, 'sold', 'owner');
      await this.repo.update(tx, id, {
        status: 'sold',
        soldAt: new Date(),
        soldPrice: input.soldPrice ?? null,
      });
      await this.repo.emit(tx, 'post.sold', id, {
        tenantId: post.tenant_id,
        actorUserId: userId,
        from: post.status_code,
        to: 'sold',
        soldPrice: input.soldPrice ?? null,
      });
    });
  }

  /**
   * The one-tap repost (ADR 031):
   *  - expired → live with a fresh listing period, bumped;
   *  - live, inside the expiry-reminder window → renewed: a fresh listing
   *    period from now, same status, not bumped (a renewal is not a boost).
   */
  repost(id: string): Promise<PostView> {
    const userId = this.requireUserId();
    return this.asOwner(id, async (post, tx) => {
      const now = new Date();
      if (post.status_code === 'live') {
        await this.renew(tx, post, userId, now);
        return;
      }
      assertTransition(post.status_code, 'live', 'owner');
      await this.repo.lockUser(tx, userId);
      await this.checkLimits(tx, { creating: false, activating: true });
      const policy = await this.repo.categoryPolicy(tx, post.category_id, post.tenant_id);
      await this.repo.update(tx, id, {
        status: 'live',
        bumpedAt: now,
        expiresAt: await this.expiryFrom(now, policy.expiryDays),
      });
      await this.repo.emit(tx, 'post.reposted', id, {
        tenantId: post.tenant_id,
        actorUserId: userId,
        from: 'expired',
        to: 'live',
      });
    });
  }

  private async renew(
    tx: DatabaseTransaction,
    post: { id: string; tenant_id: string; category_id: string; expires_at: Date | null },
    userId: string,
    now: Date,
  ): Promise<void> {
    const windowDays = await this.settings.get('post_expiry_reminder_days');
    if (post.expires_at) {
      const renewableFrom = new Date(post.expires_at.getTime() - windowDays * MS_PER_DAY);
      if (now < renewableFrom) throw new PostRenewTooEarlyException(renewableFrom);
    }
    const policy = await this.repo.categoryPolicy(tx, post.category_id, post.tenant_id);
    const expiresAt = await this.expiryFrom(now, policy.expiryDays);
    await this.repo.update(tx, post.id, { expiresAt });
    await this.repo.emit(tx, 'post.renewed', post.id, {
      tenantId: post.tenant_id,
      actorUserId: userId,
      from: 'live',
      to: 'live',
      expiresAt: expiresAt.toISOString(),
    });
  }

  setHidden(id: string, hidden: boolean): Promise<PostView> {
    const userId = this.requireUserId();
    return this.asOwner(id, async (post, tx) => {
      if (post.hidden_by_owner === hidden) return; // already so: nothing to do
      await this.repo.update(tx, id, { hiddenByOwner: hidden });
      await this.repo.emit(tx, hidden ? 'post.hidden' : 'post.unhidden', id, {
        tenantId: post.tenant_id,
        actorUserId: userId,
      });
    });
  }

  /**
   * Soft delete (deletion_reason = user_deleted); status is untouched. A sold
   * post is sales history, not deleted (schema.md §H 1a) — hide it instead.
   */
  async remove(id: string): Promise<void> {
    const userId = this.requireUserId();
    await this.asOwner(
      id,
      async (post, tx) => {
        if (post.status_code === 'sold') throw new PostNotEditableException('sold');
        const now = new Date();
        await this.repo.update(tx, id, {
          deletedAt: now,
          deletionReason: 'user_deleted',
          deletedByUserId: userId,
        });
        await this.repo.emit(tx, 'post.deleted', id, {
          tenantId: post.tenant_id,
          actorUserId: userId,
          status: post.status_code,
          reason: 'user_deleted',
        });
      },
      { returnView: false },
    );
  }

  // ---- helpers -------------------------------------------------------------

  /**
   * The submission step shared by create(submit), submit and resubmission:
   * → pending, then the moderation decision (ADR 030) — forced review, the
   * pre-filter, the author's trust — may take it on to live. Files the queue
   * item (with its reasons, or a random sample of auto-approvals).
   */
  private async applySubmission(
    tx: DatabaseTransaction,
    post: {
      id: string;
      tenantId: string;
      from: PostStatus;
      categoryId: string;
      title: string;
      description: string | null;
      price: string | null;
      ownershipResolution: string;
      authorMemberId: string;
      actorUserId: string;
      trustScore: number;
    },
  ): Promise<void> {
    assertTransition(post.from, 'pending', 'owner');
    const policy = await this.repo.categoryPolicy(tx, post.categoryId, post.tenantId);
    const forced: ForcedReviewReason[] = [];
    if (policy.moderationMode === 'pre') forced.push('pre_moderation');
    if (post.ownershipResolution === 'beyond_buffer_fallback') forced.push('outside_boundary');
    // A post a moderator rejected or removed always goes back to a human.
    if (post.from !== 'draft') forced.push('resubmission');

    const decision = await this.decision.decide(tx, {
      tenantId: post.tenantId,
      postId: post.id,
      authorMemberId: post.authorMemberId,
      title: post.title,
      description: post.description,
      categoryId: post.categoryId,
      price: post.price,
      forced,
      trustScore: post.trustScore,
    });
    const base = { tenantId: post.tenantId, actorUserId: post.actorUserId };
    await this.repo.emit(tx, 'post.submitted', post.id, {
      ...base,
      from: post.from,
      to: 'pending',
    });

    if (decision.status === 'pending') {
      await this.repo.update(tx, post.id, { status: 'pending' });
      await this.moderationRepo.fileItem(tx, {
        postId: post.id,
        source: 'submission',
        reasons: decision.reasons,
        trustScore: post.trustScore,
      });
      return;
    }

    assertTransition('pending', 'live', 'system');
    const now = new Date();
    await this.repo.update(tx, post.id, {
      status: 'live',
      publishedAt: now,
      bumpedAt: now,
      expiresAt: await this.expiryFrom(now, policy.expiryDays),
    });
    await this.repo.emit(tx, 'post.live', post.id, {
      ...base,
      from: 'pending',
      to: 'live',
      reason: 'trusted_author',
      trustScore: post.trustScore,
      sampled: decision.sampled,
    });
    if (decision.sampled) {
      await this.moderationRepo.fileItem(tx, {
        postId: post.id,
        source: 'sample',
        reasons: ['sample'],
        trustScore: post.trustScore,
      });
    }
  }

  /**
   * Loads the post in its owning tenant, locked, checks the caller is its
   * author and that it can still change, runs `work` in the same
   * transaction, then returns the fresh owner view.
   */
  private async asOwner(
    id: string,
    work: (
      post: PostRow,
      tx: DatabaseTransaction,
      scope: { requestTenantId: string },
    ) => Promise<void>,
    options: { returnView?: boolean } = {},
  ): Promise<PostView> {
    const requestTenantId = this.context.require().tenantId!;
    const tenantId = await this.ownership.tenantOf(id);
    if (!tenantId) throw new PostNotFoundException();
    await this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) =>
      this.tenantDb.transaction(async (tx) => {
        // FOR UPDATE applies the UPDATE policies, so a post the caller can
        // see but not write (someone else's live post) comes back empty:
        // tell that apart from "no such post" with a plain read.
        const post = await this.repo.findById(tx, id, { forUpdate: true });
        if (!post) {
          if (await this.repo.findById(tx, id)) throw new NotPostOwnerException();
          throw new PostNotFoundException();
        }
        if (memberId === undefined || post.author_member_id !== memberId)
          throw new NotPostOwnerException();
        if (post.scrubbed_at !== null) throw new PostNotEditableException('scrubbed');
        if (post.deleted_at !== null) throw new PostNotFoundException();
        await work(post, tx, { requestTenantId });
      }),
    );
    return options.returnView === false ? (undefined as never) : this.getOwnedView(id);
  }

  private async getOwnedView(id: string): Promise<PostView> {
    const view = await this.get(id);
    if ('scrubbed' in view) throw new PostNotFoundException();
    return view;
  }

  private requireUserId(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }

  private async checkTextLengths(
    title: string | undefined,
    description: string | undefined,
  ): Promise<void> {
    const [titleMax, descriptionMax] = await Promise.all([
      this.settings.get('post_title_max_length'),
      this.settings.get('post_description_max_length'),
    ]);
    if (title !== undefined && [...title].length > titleMax) {
      throw new PostTextTooLongException('title', titleMax);
    }
    if (description !== undefined && [...description].length > descriptionMax) {
      throw new PostTextTooLongException('description', descriptionMax);
    }
  }

  /** Per-user limits across every tenant (my_post_stats); call under lockUser. */
  private async checkLimits(
    tx: DatabaseTransaction,
    what: { creating: boolean; activating: boolean },
  ): Promise<void> {
    const [maxActive, maxPerDay] = await Promise.all([
      this.settings.get('post_max_active_per_user'),
      this.settings.get('post_max_per_day_per_user'),
    ]);
    const stats = await this.repo.myStats(tx, new Date(Date.now() - MS_PER_DAY));
    if (what.creating && stats.createdSince >= maxPerDay) {
      throw new PostLimitReachedException('daily', maxPerDay);
    }
    if (what.activating && stats.active >= maxActive) {
      throw new PostLimitReachedException('active', maxActive);
    }
  }

  /**
   * The caller's own ready images, unattached, at most post_max_media, in
   * the owning tenant. Ids that exist only in the request's tenant are the
   * buffer-zone case: a clear "upload again for that area" error.
   */
  private async checkMedia(
    tx: DatabaseTransaction,
    mediaIds: readonly string[],
    userId: string,
    postId: string | null,
    tenants: { owningTenantId: string; requestTenantId: string },
  ): Promise<string[]> {
    const unique = [...new Set(mediaIds)];
    const max = await this.settings.get('post_max_media');
    if (unique.length > max) throw new TooManyPostMediaException(max);
    if (unique.length === 0) return [];

    const usable = new Set(await this.repo.usableMedia(tx, unique, userId, postId));
    const missing = unique.filter((mediaId) => !usable.has(mediaId));
    if (missing.length === 0) return unique;

    if (tenants.owningTenantId !== tenants.requestTenantId) {
      const inRequestTenant = await this.context.run(
        { ...this.context.require(), tenantId: tenants.requestTenantId },
        () =>
          this.tenantDb.transaction(
            (other) => this.repo.usableMedia(other, missing, userId, null),
            {
              accessMode: 'read only',
            },
          ),
      );
      if (inRequestTenant.length > 0) {
        throw new PostMediaTenantMismatchException(tenants.owningTenantId, inRequestTenant);
      }
    }
    throw new PostMediaInvalidException(missing);
  }

  private async expiryFrom(now: Date, categoryDays: number | null): Promise<Date> {
    const days = categoryDays ?? (await this.settings.get('post_expiry_days_default'));
    return new Date(now.getTime() + days * MS_PER_DAY);
  }

  /** The most specific area at the point (areas come ordered country → ward). */
  private async geoAreaAt(lat: number, lng: number): Promise<string | null> {
    const areas = await this.locations.areasAt(lat, lng);
    return areas.at(-1)?.id ?? null;
  }

  private toView(
    row: PostRow,
    media: readonly PostMediaRow[],
    viewer: PostViewer,
    moderationNote: string | null = null,
  ): PostView {
    const privileged = viewer !== 'public';
    // The number itself only for the owner and staff: a buyer gets it from
    // POST /posts/:id/contact, which counts the lead (ADR 036). `whatsapp`
    // still says whether that channel is on offer.
    const phone = privileged ? row.contact_phone_e164 : null;
    const reachable = row.contact_phone_e164 !== null && (privileged || row.show_phone);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      status: row.status_code,
      categoryId: row.category_id,
      fieldSchemaId: row.field_schema_id,
      fieldSchemaVersion: row.field_schema_version,
      title: row.title,
      description: row.description,
      fields: row.fields,
      price: row.price,
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
      geoAreaId: row.geo_area_id,
      outsideBoundary: row.outside_boundary,
      ownershipResolution: row.ownership_resolution_code,
      media: media
        .filter((m) => m.post_id === row.id)
        .map((m) => {
          const variants =
            m.status_code === 'ready' && m.visibility_code === 'public'
              ? parseVariants(m.variants)
              : undefined;
          const url = (name: 'thumb' | 'card' | 'full') =>
            variants ? this.storage.getPublicUrl('media', variants[name].key) : null;
          return {
            id: m.media_asset_id,
            thumbhash: m.thumbhash,
            thumbUrl: url('thumb'),
            cardUrl: url('card'),
            fullUrl: url('full'),
          };
        }),
      showPhone: row.show_phone,
      allowChat: row.allow_chat,
      showWhatsapp: row.show_whatsapp,
      contact: {
        name: row.contact_name,
        phone,
        whatsapp: row.show_whatsapp && reachable,
      },
      isSold: row.status_code === 'sold',
      soldAt: row.sold_at?.toISOString() ?? null,
      soldPrice: row.sold_price,
      publishedAt: row.published_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      bumpedAt: row.bumped_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      isMine: viewer === 'owner',
      ...(privileged
        ? {
            hiddenByOwner: row.hidden_by_owner,
            moderationReason: row.moderation_reason_code,
            moderationNote,
          }
        : {}),
    };
  }
}

/** A rejected or removed post: its author is shown why (ADR 032). */
function hasModerationNote(row: PostRow): boolean {
  return row.status_code === 'rejected' || row.status_code === 'removed';
}

function toScrubbed(row: PostRow): ScrubbedPostView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status_code,
    scrubbed: true,
    scrubbedAt: row.scrubbed_at!.toISOString(),
    isSold: row.status_code === 'sold',
  };
}

/** Same body + same tenant = the same request; the key alone isn't trusted to mean that. */
function hashRequest(tenantId: string | undefined, input: CreatePostInput): string {
  return createHash('sha256').update(JSON.stringify({ tenantId, input })).digest('hex');
}

/** The post's price field (money string) — what the category-norm check compares. */
function priceOf(fields: Record<string, unknown>): string | null {
  const price = fields['price'];
  return typeof price === 'string' ? price : null;
}
