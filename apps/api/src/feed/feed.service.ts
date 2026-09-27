import { Inject, Injectable } from '@nestjs/common';
import { parseFieldFilters, type FieldFilter } from '../categories/field-schema';
import { CacheService } from '../cache/cache.service';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantNotFoundException, TenantRequiredException } from '../database/tenant.exceptions';
import { TenantDb } from '../database/tenant-db';
import { parseVariants } from '../media/media.types';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import type {
  BazarCard,
  EmergencyCard,
  FeedItem,
  FeedQuery,
  FeedResponse,
  FeedScope,
  LandmarkCard,
  PostCard,
  StoreCard,
} from './dto/feed.dto';
import { decodeFeedCursor, encodeFeedCursor, feedQueryKey, type FeedCursor } from './feed-cursor';
import { layoutFeedPage, storeSlotsFor, type InfoSlot } from './feed-layout';
import {
  FeedCategoryNotFoundException,
  FeedCategoryNotShippableException,
  FeedFiltersNeedFieldsException,
} from './feed.exceptions';
import {
  FeedRepository,
  type FeedCategory,
  type Origin,
  type PostCardRow,
  type RankParams,
  type RankedPost,
} from './feed.repository';
import { geohashCenter, geohashEncode } from './geohash';

// v2: post cards carry isSaved (always false in the cache).
const CACHE_KEY_VERSION = 'v2';

interface Plan {
  tenantId: string;
  scope: FeedScope;
  origin: Origin;
  /** Geohash cell of the origin: the first-page cache key. */
  cell: string;
  radiusKm: number | null;
  category: FeedCategory | null;
  categoryIds: string[] | null;
  fieldFilters: FieldFilter[];
  limit: number;
  queryKey: string;
  cursor: FeedCursor | null;
}

/**
 * GET /feed (ADR 035): a ranked, radius-based mix of post cards, nearby store
 * cards and — on the first page — info cards (emergency shortcut, bazar
 * prices today, landmarks).
 *
 * Ranking happens in feed_posts (SQL, weights from SettingsService); cards
 * are then read in each owning tenant's context as `anon`, so a card never
 * shows more than that tenant's public-read policy allows. The first page is
 * cached per (tenant, geohash cell, category, query) for
 * feed_cache_ttl_seconds; the origin snaps to the cell centre so a cached
 * page is exactly what any viewer in the cell would have got.
 */
@Injectable()
export class FeedService {
  constructor(
    private readonly repo: FeedRepository,
    private readonly settings: SettingsService,
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly cache: CacheService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async feed(query: FeedQuery): Promise<FeedResponse> {
    const response = await this.sharedPage(query);
    return { ...response, items: await this.withSaved(response.items) };
  }

  /**
   * Marks the cards the signed-in viewer saved. Runs after the page cache,
   * which is shared by everyone in a geohash cell, so the cache never holds
   * one user's saves. One query per page; guests skip it.
   */
  async withSaved<T extends FeedItem | PostCard>(items: T[]): Promise<T[]> {
    if (!this.context.current()?.userId) return items;
    const ids = items.flatMap((item) => (item.kind === 'post' ? [item.id] : []));
    const saved = await this.readOnly((tx) => this.repo.savedPostIds(tx, ids));
    if (saved.size === 0) return items;
    return items.map((item) =>
      item.kind === 'post' && saved.has(item.id) ? { ...item, isSaved: true } : item,
    );
  }

  private async sharedPage(query: FeedQuery): Promise<FeedResponse> {
    const plan = await this.plan(query);
    if (plan.cursor !== null) return this.page(plan);

    const ttl = await this.settings.get('feed_cache_ttl_seconds');
    if (ttl === 0) return this.page(plan);
    const key = [
      'feed',
      CACHE_KEY_VERSION,
      plan.cell,
      plan.category?.id ?? 'all',
      plan.queryKey,
      plan.limit,
    ].join(':');
    return this.cache.forTenant(plan.tenantId).remember(key, ttl, () => this.page(plan));
  }

  /**
   * "Similar posts" under a post's detail (ADR 036): the same category within
   * `radiusKm` of the post, ranked exactly like the category feed (weights of
   * the post's own tenant), without the post itself.
   */
  async similarPosts(q: {
    tenantId: string;
    origin: Origin;
    radiusKm: number;
    categoryId: string;
    excludeId: string;
    limit: number;
  }): Promise<PostCard[]> {
    if (q.limit <= 0) return [];
    const rank = await this.rankParams(q.tenantId);
    const ranked = await this.readOnly((tx) =>
      this.repo.rankPosts(tx, {
        origin: q.origin,
        radiusKm: q.radiusKm,
        categoryIds: [q.categoryId],
        shippableOnly: false,
        fieldFilters: [],
        boostPlacement: 'category_top',
        rank,
        asOf: new Date(),
        after: null,
        // One extra: the post itself usually ranks first.
        limit: q.limit + 1,
      }),
    );
    return this.withSaved(
      await this.postCards(ranked.filter((r) => r.id !== q.excludeId).slice(0, q.limit)),
    );
  }

  private async plan(query: FeedQuery): Promise<Plan> {
    const tenantId = this.requireTenant();
    const [defaultRadius, maxRadius, pageDefault, pageMax, precision] = await Promise.all([
      this.settings.get('feed_default_radius_km', tenantId),
      this.settings.get('feed_max_radius_km'),
      this.settings.get('feed_page_size_default'),
      this.settings.get('feed_page_size_max'),
      this.settings.get('feed_cache_geohash_precision'),
    ]);

    const category = query.category
      ? await this.readOnly((tx) => this.repo.resolveCategory(tx, query.category!))
      : null;
    if (query.category && !category) throw new FeedCategoryNotFoundException();

    let fieldFilters: FieldFilter[] = [];
    if (query.filters && query.filters.length > 0) {
      if (!category?.definition) throw new FeedFiltersNeedFieldsException();
      fieldFilters = parseFieldFilters(category.definition, query.filters);
    }

    let categoryIds = category?.ids ?? null;
    if (query.scope === 'country' && category) {
      if (category.shippableIds.length === 0) throw new FeedCategoryNotShippableException();
      categoryIds = category.shippableIds;
    }

    const radiusKm =
      query.scope === 'country'
        ? null
        : query.scope === 'nearby'
          ? Math.min(query.radius_km ?? defaultRadius, maxRadius)
          : defaultRadius;
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const queryKey = feedQueryKey({
      scope: query.scope,
      category: category?.id ?? null,
      filters: fieldFilters,
      radius: radiusKm,
    });
    const cursor = query.cursor ? decodeFeedCursor(query.cursor, queryKey) : null;

    // A cursor fixes the origin for the whole scroll (scores depend on it).
    const viewer = cursor?.o ?? (await this.viewerOrigin(tenantId, query));
    const cell = geohashEncode(viewer.lat, viewer.lng, precision);
    const origin = cursor?.o ?? geohashCenter(cell);

    return {
      tenantId,
      scope: query.scope,
      origin,
      cell,
      radiusKm,
      category: category ?? null,
      categoryIds,
      fieldFilters,
      limit,
      queryKey,
      cursor,
    };
  }

  private async page(plan: Plan): Promise<FeedResponse> {
    const asOf = plan.cursor ? new Date(plan.cursor.at) : new Date();
    const firstPage = plan.cursor === null;
    const nearby = plan.radiusKm !== null;
    // Info cards don't depend on the ranking: start them alongside it.
    const info = firstPage ? this.infoCards(plan, nearby) : Promise.resolve([]);
    // Awaited below; this only keeps a failure from surfacing as unhandled
    // if the ranking throws first.
    info.catch(() => undefined);
    const rank = await this.rankParams(plan.tenantId);
    const ranked = await this.readOnly((tx) =>
      this.repo.rankPosts(tx, {
        origin: plan.origin,
        radiusKm: plan.radiusKm,
        categoryIds: plan.categoryIds,
        shippableOnly: plan.scope === 'country',
        fieldFilters: plan.fieldFilters,
        boostPlacement: plan.category ? 'category_top' : 'home_featured',
        rank,
        asOf,
        after: plan.cursor ? { score: plan.cursor.p.s, id: plan.cursor.p.id } : null,
        limit: plan.limit,
      }),
    );

    const postsBefore = plan.cursor?.n ?? 0;
    const storeInterval = nearby
      ? await this.settings.get('feed_store_card_interval', plan.tenantId)
      : 0;
    const storeSlots = storeSlotsFor(postsBefore, ranked.length, storeInterval);

    const [posts, stores, infoSlots] = await Promise.all([
      this.postCards(ranked),
      storeSlots > 0 && plan.radiusKm !== null
        ? this.storeCards(plan.origin, plan.radiusKm, plan.cursor?.s ?? null, storeSlots)
        : Promise.resolve({ cards: [], keyAfter: () => plan.cursor?.s ?? null }),
      info,
    ]);

    const { items, storesUsed } = layoutFeedPage<FeedItem, FeedItem, FeedItem>({
      posts,
      stores: stores.cards,
      postsBefore,
      storeInterval,
      info: infoSlots,
    });

    const last = ranked.at(-1);
    const nextCursor =
      last !== undefined && ranked.length === plan.limit
        ? encodeFeedCursor({
            k: plan.queryKey,
            at: asOf.getTime(),
            o: plan.origin,
            r: plan.radiusKm,
            p: { s: last.score, id: last.id },
            s: stores.keyAfter(storesUsed),
            // Cards shown, as the layout counted them for the store rhythm.
            n: postsBefore + posts.length,
          })
        : null;

    return { items, nextCursor, scope: plan.scope, radiusKm: plan.radiusKm };
  }

  private async rankParams(tenantId: string): Promise<RankParams> {
    const [
      wDistance,
      wRecency,
      wBoost,
      wTrust,
      wCompleteness,
      distanceHalfKm,
      recencyHalfLifeHours,
      photoTarget,
      trustDefault,
    ] = await Promise.all([
      this.settings.get('feed_weight_distance', tenantId),
      this.settings.get('feed_weight_recency', tenantId),
      this.settings.get('feed_weight_boost', tenantId),
      this.settings.get('feed_weight_trust', tenantId),
      this.settings.get('feed_weight_completeness', tenantId),
      this.settings.get('feed_distance_half_km', tenantId),
      this.settings.get('feed_recency_half_life_hours', tenantId),
      this.settings.get('feed_completeness_photo_target'),
      this.settings.get('trust_base_score', tenantId),
    ]);
    return {
      w_distance: wDistance,
      w_recency: wRecency,
      w_boost: wBoost,
      w_trust: wTrust,
      w_completeness: wCompleteness,
      distance_half_km: distanceHalfKm,
      recency_half_life_hours: recencyHalfLifeHours,
      photo_target: photoTarget,
      trust_default: trustDefault,
    };
  }

  // ---- cards ----------------------------------------------------------------

  /** Cards in rank order; a post hidden or sold since ranking just drops out. */
  private async postCards(ranked: readonly RankedPost[]): Promise<PostCard[]> {
    const rows = await this.inOwners(ranked, (tx, ids) => this.repo.postCards(tx, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ranked.flatMap((r) => {
      const row = byId.get(r.id);
      return row ? [this.toPostCard(row, r)] : [];
    });
  }

  private toPostCard(row: PostCardRow, ranked: RankedPost): PostCard {
    const badges: PostCard['badges'] = [];
    if (ranked.is_boosted) badges.push('boosted');
    if (ranked.is_highlighted) badges.push('highlighted');
    if (row.store_verified) badges.push('verified_store');
    if (row.price_type_code === 'free') badges.push('free');
    if (row.price_type_code === 'negotiable') badges.push('negotiable');
    return {
      kind: 'post',
      id: row.id,
      tenantId: row.tenant_id,
      title: row.title,
      price: row.price,
      cover: this.cover(row.cover_thumbhash, row.cover_variants),
      distanceMeters: ranked.distance_m === null ? null : Math.round(ranked.distance_m),
      area:
        row.area_bn === null && row.area_en === null ? null : { bn: row.area_bn, en: row.area_en },
      badges,
      createdAt: row.created_at.toISOString(),
      isSaved: false,
    };
  }

  private async storeCards(
    origin: Origin,
    radiusKm: number,
    after: FeedCursor['s'],
    limit: number,
  ): Promise<{ cards: StoreCard[]; keyAfter: (used: number) => FeedCursor['s'] }> {
    const nearest = await this.readOnly((tx) =>
      this.repo.nearestStores(tx, {
        origin,
        radiusKm,
        after: after ? { distance: after.d, id: after.id } : null,
        limit,
      }),
    );
    const rows = await this.inOwners(nearest, (tx, ids) => this.repo.storeCards(tx, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const cards: StoreCard[] = [];
    const keys: NonNullable<FeedCursor['s']>[] = [];
    for (const n of nearest) {
      const row = byId.get(n.id);
      if (!row) continue;
      cards.push({
        kind: 'store',
        id: row.id,
        tenantId: row.tenant_id,
        slug: row.slug,
        name: { bn: row.name_bn, en: row.name_en },
        cover: this.cover(row.cover_thumbhash, row.cover_variants),
        distanceMeters: Math.round(n.distance_m),
        isVerified: row.is_verified,
        rating: row.rating_avg,
      });
      keys.push({ d: n.distance_m, id: n.id });
    }
    return { cards, keyAfter: (used) => keys[used - 1] ?? after };
  }

  private async infoCards(plan: Plan, nearby: boolean): Promise<InfoSlot<FeedItem>[]> {
    const tenantId = plan.tenantId;
    const [emergencyAt, emergencyItems, bazarAt, bazarItems, landmarkAt, landmarkMax] =
      await Promise.all([
        this.settings.get('feed_emergency_card_position', tenantId),
        this.settings.get('feed_emergency_card_items'),
        this.settings.get('feed_bazar_card_position', tenantId),
        this.settings.get('feed_bazar_card_items', tenantId),
        this.settings.get('feed_landmark_card_position', tenantId),
        this.settings.get('feed_landmark_cards_max', tenantId),
      ]);

    const [hotlines, bazar, landmarks] = await Promise.all([
      emergencyAt > 0 ? this.readOnly((tx) => this.repo.hotlines(tx, emergencyItems)) : [],
      bazarAt > 0 ? this.readOnly((tx) => this.repo.bazarToday(tx, bazarItems)) : [],
      landmarkAt > 0 && nearby ? this.landmarkCards(plan.origin, landmarkMax) : [],
    ]);

    const emergency: EmergencyCard | null =
      hotlines.length === 0
        ? null
        : {
            kind: 'emergency',
            hotlines: hotlines.map((h) => ({
              serviceType: h.service_type_code,
              name: { bn: h.name_bn, en: h.name_en },
              dial: h.dial_string,
            })),
          };
    const bazarCard: BazarCard | null =
      bazar.length === 0
        ? null
        : {
            kind: 'bazar_prices',
            date: bazar[0]!.price_date,
            items: bazar.map((b) => ({
              commodity: b.commodity_code,
              name: { bn: b.name_bn, en: b.name_en },
              unit: b.unit_code,
              minPrice: b.min_price,
              maxPrice: b.max_price,
            })),
          };
    return [
      { position: emergencyAt, cards: emergency ? [emergency] : [] },
      { position: bazarAt, cards: bazarCard ? [bazarCard] : [] },
      { position: landmarkAt, cards: landmarks },
    ];
  }

  private async landmarkCards(origin: Origin, limit: number): Promise<LandmarkCard[]> {
    const nearest = await this.readOnly((tx) => this.repo.landmarks(tx, origin, limit));
    const rows = await this.inOwners(nearest, (tx, ids) => this.repo.landmarkCards(tx, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return nearest.flatMap((n) => {
      const row = byId.get(n.id);
      if (!row) return [];
      return [
        {
          kind: 'landmark' as const,
          id: row.id,
          tenantId: row.tenant_id,
          slug: row.slug,
          name: { bn: row.name_bn, en: row.name_en },
          category: {
            slug: row.category_slug,
            name: { bn: row.category_name_bn, en: row.category_name_en },
          },
          distanceMeters: Math.round(n.distance_m),
        },
      ];
    });
  }

  private cover(thumbhash: string | null, variants: unknown): PostCard['cover'] {
    const parsed = parseVariants(variants);
    if (!parsed) return null;
    return { url: this.storage.getPublicUrl('media', parsed.card.key), thumbhash };
  }

  // ---- context helpers ------------------------------------------------------

  /**
   * Reads rows owned by several tenants: one read-only transaction per owner,
   * in that owner's context as `anon` — never with the viewer's role, which
   * could be staff in their own tenant but is nobody in the owner's.
   */
  private async inOwners<T>(
    refs: readonly { id: string; tenant_id: string }[],
    read: (tx: DatabaseTransaction, ids: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    const byTenant = new Map<string, string[]>();
    for (const ref of refs) {
      const ids = byTenant.get(ref.tenant_id) ?? [];
      ids.push(ref.id);
      byTenant.set(ref.tenant_id, ids);
    }
    const results = await Promise.all(
      [...byTenant].map(([tenantId, ids]) =>
        this.context.run({ tenantId, role: 'anon' }, () =>
          this.tenantDb.transaction((tx) => read(tx, ids), { accessMode: 'read only' }),
        ),
      ),
    );
    return results.flat();
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }

  private async viewerOrigin(
    tenantId: string,
    query: { lat?: number | undefined; lng?: number | undefined },
  ): Promise<Origin> {
    if (query.lat !== undefined && query.lng !== undefined)
      return { lat: query.lat, lng: query.lng };
    const center = await this.readOnly((tx) => this.repo.tenantCenter(tx, tenantId));
    if (!center) throw new TenantNotFoundException();
    return center;
  }

  private requireTenant(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}
