import { Inject, Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { sqlStateOf } from '../common/utils/sql-state';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { MediaService } from '../media/media.service';
import { parseVariants } from '../media/media.types';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { SettingsService } from '../settings/settings.service';
import { MediaAssetNotFoundException } from '../storage/storage.exceptions';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { TrustScoreService } from '../trust/trust-score.service';
import type {
  Eligibility,
  MyReview,
  ReportResult,
  ReportReviewInput,
  RespondInput,
  ReviewImagePresigned,
  ReviewImagePresignInput,
  ReviewImageStatus,
  ReviewPage,
  ReviewPageQuery,
  ReviewPhoto,
  WriteResult,
  WriteReviewInput,
} from './dto/reviews.dto';
import {
  ReviewDecidedException,
  ReviewEditWindowOverException,
  ReviewNotEligibleException,
  ReviewNotFoundException,
  ReviewOwnReportException,
  ReviewPhotosInvalidException,
  ReviewReplyForbiddenException,
  ReviewStoreNotFoundException,
  ReviewTextTooLongException,
} from './reviews.exceptions';
import {
  ReviewsRepository,
  type MyReviewRow,
  type PhotoRow,
  type WriteRow,
} from './reviews.repository';
import { SellerScoreService } from './seller-score.service';

const UNIQUE_VIOLATION = '23505';
// settings-exempt: the star scale (reviews_rating_ck, 1–5), not a tunable
const STARS = [1, 2, 3, 4, 5] as const;

/**
 * Reviews of a store (ADR 061), for members and for the store. Everything
 * runs in the store's own tenant (a buyer may live in a neighbouring area):
 * reading as whoever the caller is there, writing with their membership
 * there (a review is a first write, like a post). The rules — the anti-fake
 * eligibility, the integrity flags, one per store, the edit window, who may
 * reply — are the 0057 functions'; this maps their answers to typed errors.
 * The author's trust comes from TrustScoreService (the one trust rule).
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly repo: ReviewsRepository,
    private readonly settings: SettingsService,
    private readonly trust: TrustScoreService,
    private readonly scores: SellerScoreService,
    private readonly media: MediaService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  // ---- reading --------------------------------------------------------------

  async page(storeId: string, query: ReviewPageQuery): Promise<ReviewPage> {
    const tenantId = await this.storeTenant(storeId);
    const max = await this.settings.get('review_page_size_max', tenantId);
    const limit = Math.min(query.limit ?? max, max);
    const [{ rows, histogram }, tier] = await Promise.all([
      this.ownership.inTenant(tenantId, 'lookup', () =>
        this.read(async (tx) => ({
          rows: await this.repo.page(tx, storeId, query.before, limit + 1),
          histogram: await this.repo.histogram(tx, storeId),
        })),
      ),
      this.scores.tier(tenantId, storeId),
    ]);
    const page = rows.slice(0, limit);
    const count = [...histogram.values()].reduce((a, b) => a + b, 0);
    const total = [...histogram.entries()].reduce((sum, [stars, n]) => sum + stars * n, 0);
    const star = (n: number) => histogram.get(n) ?? 0;
    return {
      summary: {
        // settings-exempt: two decimals, as stores.rating_avg numeric(3,2)
        average: count === 0 ? null : Math.round((total / count) * 100) / 100,
        count,
        histogram: Object.fromEntries(
          STARS.map((n) => [String(n), star(n)]),
        ) as ReviewPage['summary']['histogram'],
        tier,
      },
      items: page.map((r) => ({
        id: r.review_id,
        rating: r.rating,
        text: r.body,
        authorName: r.author_name,
        authorRemoved: r.author_scrubbed,
        verifiedContact: true,
        createdAt: r.created_at,
        editedAt: r.edited_at,
        photos: this.photos(r.photos),
        response:
          r.response_body !== null && r.response_at !== null
            ? { text: r.response_body, createdAt: r.response_at, editedAt: r.response_edited_at }
            : null,
      })),
      nextBefore: rows.length > limit ? (page[page.length - 1]?.review_id ?? null) : null,
    };
  }

  /** May the caller review this store, and their review if they wrote one. */
  async eligibility(storeId: string): Promise<Eligibility> {
    const tenantId = await this.storeTenant(storeId);
    if (!this.context.require().userId) {
      return { status: 'signed_out', eligibleAt: null, expiresAt: null, myReview: null };
    }
    return this.ownership.inTenant(tenantId, 'lookup', () =>
      this.read(async (tx) => {
        const row = await this.repo.eligibility(tx, storeId);
        const mine =
          row.status === 'already_reviewed' ? await this.repo.mine(tx, storeId) : undefined;
        return {
          status: row.status,
          eligibleAt: row.eligible_at,
          expiresAt: row.expires_at,
          myReview: mine ? this.myView(mine) : null,
        };
      }),
    );
  }

  // ---- writing --------------------------------------------------------------

  async submit(storeId: string, input: WriteReviewInput): Promise<WriteResult> {
    this.requireUser();
    const tenantId = await this.storeTenant(storeId);
    return this.ownership.inTenant(tenantId, 'ensure', async ({ memberId }) => {
      const trust = await this.trust.get(tenantId, memberId!);
      const written = await this.write(tenantId, storeId, () =>
        this.tenantDb.transaction((tx) =>
          this.repo.submit(tx, {
            storeId,
            rating: input.rating,
            text: input.text ?? null,
            photoIds: input.photoIds,
            trust: trust.score,
          }),
        ),
      );
      return this.result(storeId, written);
    });
  }

  async edit(storeId: string, input: WriteReviewInput): Promise<WriteResult> {
    this.requireUser();
    const tenantId = await this.storeTenant(storeId);
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      if (!memberId) throw new ReviewNotFoundException();
      const mine = await this.read((tx) => this.repo.mine(tx, storeId));
      if (!mine) throw new ReviewNotFoundException();
      const trust = await this.trust.get(tenantId, memberId);
      const written = await this.write(tenantId, storeId, () =>
        this.tenantDb.transaction((tx) =>
          this.repo.edit(tx, {
            reviewId: mine.review_id,
            rating: input.rating,
            text: input.text ?? null,
            photoIds: input.photoIds,
            trust: trust.score,
          }),
        ),
      );
      return this.result(storeId, written);
    });
  }

  /** The store's reply (one per review; a second call edits it). */
  async respond(
    storeId: string,
    reviewId: string,
    input: RespondInput,
  ): Promise<{ created: boolean }> {
    this.requireUser();
    const tenantId = await this.storeTenant(storeId);
    return this.ownership.inTenant(tenantId, 'lookup', async ({ memberId }) => {
      if (!memberId) throw new ReviewReplyForbiddenException();
      const created = await this.write(
        tenantId,
        storeId,
        () => this.tenantDb.transaction((tx) => this.repo.respond(tx, reviewId, input.text)),
        'response',
      );
      return { created };
    });
  }

  /** Anyone may report a review (the store's owner most of all); nobody but a moderator removes one. */
  async report(storeId: string, reviewId: string, input: ReportReviewInput): Promise<ReportResult> {
    this.requireUser();
    const tenantId = await this.storeTenant(storeId);
    return this.ownership.inTenant(tenantId, 'ensure', () =>
      this.write(tenantId, storeId, () =>
        this.tenantDb.transaction((tx) =>
          this.repo.report(tx, reviewId, input.reasonCode, input.details ?? null),
        ),
      ),
    );
  }

  // ---- photos: the media pipeline, in the store's tenant -----------------------

  presignImage(storeId: string, input: ReviewImagePresignInput): Promise<ReviewImagePresigned> {
    return this.inStoreTenant(storeId, async () => {
      const presigned = await this.media.presign({ ...input, kind: 'image' });
      return { mediaId: presigned.id, upload: presigned.upload };
    });
  }

  confirmImage(storeId: string, mediaId: string): Promise<ReviewImageStatus> {
    return this.inStoreTenant(storeId, async () => {
      await this.ownImage(mediaId);
      const status = await this.media.confirm(mediaId);
      return { mediaId, status: status.status };
    });
  }

  imageStatus(storeId: string, mediaId: string): Promise<ReviewImageStatus> {
    return this.inStoreTenant(storeId, async () => ({
      mediaId,
      status: (await this.ownImage(mediaId)) as ReviewImageStatus['status'],
    }));
  }

  // ---- helpers --------------------------------------------------------------

  private async inStoreTenant<T>(storeId: string, work: () => Promise<T>): Promise<T> {
    this.requireUser();
    const tenantId = await this.storeTenant(storeId);
    return this.ownership.inTenant(tenantId, 'ensure', work);
  }

  private async ownImage(mediaId: string): Promise<string> {
    const userId = this.requireUser();
    const status = await this.read((tx) => this.repo.ownImageStatus(tx, mediaId, userId));
    if (!status) throw new MediaAssetNotFoundException();
    return status;
  }

  private async result(storeId: string, written: WriteRow): Promise<WriteResult> {
    const mine = await this.read((tx) => this.repo.mine(tx, storeId));
    if (!mine) throw new ReviewNotFoundException();
    return { review: this.myView(mine), needsReview: written.status_code === 'pending' };
  }

  /** Runs a write; maps the 0057 functions' errors (AE6xx) to typed ones. */
  private async write<T>(
    tenantId: string,
    storeId: string,
    work: () => Promise<T>,
    target: 'review' | 'response' = 'review',
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      switch (sqlStateOf(error)) {
        case 'AE601':
        case UNIQUE_VIOLATION: {
          const row = await this.read((tx) => this.repo.eligibility(tx, storeId));
          throw new ReviewNotEligibleException({
            status: row.status === 'eligible' ? 'already_reviewed' : row.status,
            eligibleAt: row.eligible_at,
            expiresAt: row.expires_at,
          });
        }
        case 'AE603':
          throw new ReviewTextTooLongException({
            max: await this.settings.get(
              target === 'response' ? 'review_response_max_length' : 'review_text_max_length',
              tenantId,
            ),
          });
        case 'AE611':
        case 'AE612':
          throw new ReviewPhotosInvalidException({
            max: await this.settings.get('review_photos_max', tenantId),
          });
        case 'AE604':
        case 'AE608':
          throw new ReviewNotFoundException();
        case 'AE605':
          throw new ReviewEditWindowOverException();
        case 'AE606':
          throw new ReviewDecidedException();
        case 'AE607':
          throw new ReviewReplyForbiddenException();
        case 'AE609':
          throw new ReviewOwnReportException();
        default:
          throw error;
      }
    }
  }

  private myView(row: MyReviewRow): MyReview {
    return {
      id: row.review_id,
      rating: row.rating,
      text: row.body,
      status: row.status_code,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      editableUntil: row.editable_until,
      photos: this.photos(row.photos),
    };
  }

  private photos(rows: readonly PhotoRow[]): ReviewPhoto[] {
    return rows.map((p) => {
      const variants = parseVariants(p.variants);
      const url = (name: 'thumb' | 'card' | 'full') =>
        variants ? this.storage.getPublicUrl('media', variants[name].key) : null;
      return {
        id: p.id,
        thumbhash: p.thumbhash,
        thumbUrl: url('thumb'),
        cardUrl: url('card'),
        fullUrl: url('full'),
      };
    });
  }

  private async storeTenant(storeId: string): Promise<string> {
    const tenantId = await this.tenantDb.transaction((tx) => this.repo.storeTenantOf(tx, storeId), {
      accessMode: 'read only',
    });
    if (!tenantId) throw new ReviewStoreNotFoundException();
    return tenantId;
  }

  private read<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }

  private requireUser(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }
}
