import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantDb } from '../database/tenant-db';
import { SearchUnavailableError } from '../search/engine/search-engine.port';
import { SearchMatcher, type SearchCriteria } from '../search/query/search-matcher';
import { SearchQueryRepository } from '../search/query/search-query.repository';
import { SettingsService } from '../settings/settings.service';
import type {
  CategoryAreas,
  ListingStatus,
  SitemapPageQuery,
  SitemapPosts,
  SitemapStores,
  SitemapSummary,
} from './dto/seo.dto';
import { SeoSearchUnavailableException } from './seo.exceptions';
import { SeoRepository } from './seo.repository';

// settings-exempt: unit conversion (the window itself is sold_noindex_days)
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * What the public web pages need beyond the feed and the detail (ADR 039):
 * the HTTP answer for a listing URL and the sitemap's data. Store pages are
 * the stores module's (GET /stores/:slug, ADR 054).
 */
@Injectable()
export class SeoService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: SeoRepository,
    private readonly settings: SettingsService,
    private readonly matcher: SearchMatcher,
    private readonly searchRepo: SearchQueryRepository,
  ) {}

  /**
   * The category + area landing pages that exist (ADR 042): every enabled
   * category × active area of the host tenant with at least
   * seo_area_page_min_listings listings. Counted per area with exactly the
   * criteria the page itself searches with (the area's centre, the area
   * radius, the area filter, the category's tree), through the shared
   * SearchMatcher — so the sitemap, the 404 gate and the page agree.
   */
  async categoryAreas(): Promise<CategoryAreas> {
    const tenantId = this.requireTenant();
    const [minListings, radiusKm] = await Promise.all([
      this.settings.get('seo_area_page_min_listings', tenantId),
      this.settings.get('search_default_radius_km', tenantId),
    ]);
    const [areas, categories, tenantCenter] = await this.readOnly(async (tx) =>
      Promise.all([
        this.repo.activeAreas(tx),
        this.repo.enabledCategoryTrees(tx),
        this.searchRepo.tenantCenter(tx, tenantId),
      ]),
    );
    const located = areas.filter((a) => (a.lat !== null && a.lng !== null) || tenantCenter);
    if (located.length === 0 || categories.length === 0) return { minListings, items: [] };

    const criteria: SearchCriteria[] = located.map((area) => ({
      type: 'posts',
      q: '',
      origin:
        area.lat !== null && area.lng !== null ? { lat: area.lat, lng: area.lng } : tenantCenter!,
      radiusKm,
      shippableOnly: false,
      localityId: area.id,
      categoryIds: null,
      fieldFilters: [],
      price: null,
    }));
    let counts: Record<string, number>[];
    try {
      counts = await this.matcher.facetCountsEach(criteria, 'category_id');
    } catch (error) {
      if (error instanceof SearchUnavailableError) throw new SeoSearchUnavailableException();
      throw error;
    }

    const items: CategoryAreas['items'] = [];
    located.forEach((area, i) => {
      for (const category of categories) {
        const count = category.ids.reduce((sum, id) => sum + (counts[i]?.[id] ?? 0), 0);
        if (count < minListings) continue;
        items.push({
          category: { slug: category.slug, name: { bn: category.name_bn, en: category.name_en } },
          area: { slug: area.slug, name: { bn: area.name_bn, en: area.name_en } },
          count,
        });
      }
    });
    items.sort((a, b) => b.count - a.count || a.area.slug.localeCompare(b.area.slug));
    return { minListings, items };
  }

  /** live/sold → render (indexable unless sold longer than sold_noindex_days), gone → 410, not_found → 404. */
  async listingStatus(postId: string): Promise<ListingStatus> {
    const row = await this.readOnly((tx) => this.repo.listingStatus(tx, postId));
    if (!row || row.state === 'not_found') {
      return {
        state: 'not_found',
        tenantId: null,
        tenantSlug: null,
        title: null,
        indexable: false,
        soldAt: null,
        updatedAt: null,
      };
    }
    let indexable = row.state === 'live';
    if (row.state === 'sold' && row.sold_at) {
      const days = await this.settings.get('sold_noindex_days', row.tenant_id);
      indexable = Date.now() - row.sold_at.getTime() < days * MS_PER_DAY;
    }
    return {
      state: row.state,
      tenantId: row.tenant_id,
      tenantSlug: row.tenant_slug,
      title: row.title,
      indexable,
      soldAt: row.sold_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async sitemapSummary(): Promise<SitemapSummary> {
    const tenantId = this.requireTenant();
    const [days, urlsPerFile] = await Promise.all([
      this.settings.get('sold_noindex_days', tenantId),
      this.settings.get('sitemap_urls_per_file', tenantId),
    ]);
    const [posts, stores] = await this.readOnly(async (tx) => [
      await this.repo.countSitemapPosts(tx, days),
      await this.repo.countStores(tx),
    ]);
    return { posts, stores, urlsPerFile };
  }

  async sitemapPosts(query: SitemapPageQuery): Promise<SitemapPosts> {
    const tenantId = this.requireTenant();
    const [days, perFile] = await Promise.all([
      this.settings.get('sold_noindex_days', tenantId),
      this.settings.get('sitemap_urls_per_file', tenantId),
    ]);
    const rows = await this.readOnly((tx) =>
      this.repo.sitemapPosts(tx, days, query.offset, Math.min(query.limit ?? perFile, perFile)),
    );
    return {
      items: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at.toISOString() })),
    };
  }

  async sitemapStores(query: SitemapPageQuery): Promise<SitemapStores> {
    const tenantId = this.requireTenant();
    const perFile = await this.settings.get('sitemap_urls_per_file', tenantId);
    const rows = await this.readOnly((tx) =>
      this.repo.sitemapStores(tx, query.offset, Math.min(query.limit ?? perFile, perFile)),
    );
    return { items: rows.map((r) => ({ slug: r.slug, updatedAt: r.updated_at.toISOString() })) };
  }

  private requireTenant(): string {
    const tenantId = this.context.current()?.tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }
}
