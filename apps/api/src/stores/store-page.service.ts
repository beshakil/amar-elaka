import { Inject, Injectable } from '@nestjs/common';
import { AnalyticsTracker } from '../analytics/seller/analytics-tracker.service';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { FeedRepository } from '../feed/feed.repository';
import { FeedService } from '../feed/feed.service';
import { HoursService } from '../hours/hours.service';
import { viewerKey, type ViewerSignals } from '../engagement/viewer-key';
import { parseVariants } from '../media/media.types';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { VERIFICATION_BADGES, type StorePage, type StorePageQuery } from './dto/stores.dto';
import { StoreNotFoundException } from './stores.exceptions';
import { StoresRepository } from './stores.repository';

type Badge = (typeof VERIFICATION_BADGES)[number];

/** A verified store shows the business badge; otherwise its owner's seller verification does. */
export function verificationBadge(storeVerified: boolean, sellerLevel: string | null): Badge {
  if (storeVerified) return 'business';
  return (VERIFICATION_BADGES as readonly string[]).includes(sellerLevel ?? '')
    ? (sellerLevel as Badge)
    : 'none';
}

/**
 * GET /stores/:slug (ADR 039, ADR 054): the host tenant's active store —
 * profile, hours with the open state (HoursService, is_open_at), stats,
 * verification badge, map pin and the catalog (its listed posts, filterable
 * by category, the feed's own cards). An old slug still finds the store; the
 * page carries the current one. No phone numbers: POST /stores/:id/contact.
 */
@Injectable()
export class StorePageService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: StoresRepository,
    private readonly feedRepo: FeedRepository,
    private readonly feed: FeedService,
    private readonly hours: HoursService,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly tracker: AnalyticsTracker,
    @Inject(APP_CONFIG) private readonly env: Pick<Env, 'JWT_SECRET'>,
  ) {}

  async page(slug: string, query: StorePageQuery, viewer?: ViewerSignals): Promise<StorePage> {
    if (!this.context.current()?.tenantId) throw new TenantRequiredException();
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('feed_page_size_default'),
      this.settings.get('feed_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);

    const found = await this.readOnly(async (tx) => {
      const row = await this.repo.page(tx, slug);
      if (!row) return undefined;
      // An unknown category filter is an empty catalog, not every post.
      const categoryIds = query.category
        ? ((await this.feedRepo.resolveCategory(tx, query.category))?.ids ?? [])
        : null;
      const [refs, categories] = await Promise.all([
        this.repo.catalogRefs(tx, row.id, categoryIds, query.cursor ?? null, limit + 1),
        this.repo.catalogCategories(tx, row.id),
      ]);
      return { row, refs, categories };
    });
    if (!found) throw new StoreNotFoundException();
    const { row, refs, categories } = found;
    const page = refs.slice(0, limit);
    // The store's own page views for its dashboard (ADR 055), once per visitor per view_dedupe_hours.
    if (viewer) {
      this.tracker.storePageView({
        tenantId: row.tenant_id,
        storeId: row.id,
        visitor: viewerKey(this.env.JWT_SECRET, viewer),
      });
    }
    const [hours, posts] = await Promise.all([
      this.hours.storeHours(row.id),
      this.feed.cardsFor(page),
    ]);

    return {
      id: row.id,
      tenantId: row.tenant_id,
      slug: row.slug,
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
      addressText: row.address_text,
      area:
        row.area_bn === null && row.area_en === null ? null : { bn: row.area_bn, en: row.area_en },
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
      mapPin:
        row.pin_lat !== null && row.pin_lng !== null
          ? { lat: row.pin_lat, lng: row.pin_lng, placeId: row.place_id }
          : row.lat !== null && row.lng !== null
            ? { lat: row.lat, lng: row.lng, placeId: null }
            : null,
      logo: this.image(row.logo_variants, row.logo_thumbhash),
      cover: this.image(row.cover_variants, row.cover_thumbhash),
      isVerified: row.is_verified,
      verification: {
        badge: verificationBadge(row.is_verified, row.seller_level),
        storeVerified: row.is_verified,
      },
      rating: row.rating,
      ratingCount: row.rating_count,
      followerCount: row.follower_count,
      stats: {
        followers: row.follower_count,
        livePosts: row.live_posts,
        memberSince: row.created_at.toISOString(),
      },
      hours,
      catalogCategories: categories.map((c) => ({
        slug: c.slug,
        name: { bn: c.name_bn, en: c.name_en },
        count: c.count,
      })),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      posts,
      nextCursor: refs.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  private image(variants: unknown, thumbhash: string | null): StorePage['logo'] {
    const parsed = parseVariants(variants);
    return parsed ? { url: this.storage.getPublicUrl('media', parsed.card.key), thumbhash } : null;
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }
}
