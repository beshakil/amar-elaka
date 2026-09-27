import { Inject, Injectable } from '@nestjs/common';
import { parseFieldSchema, parseUiSchema, renderFields } from '../categories/field-schema';
import type { FieldValues } from '../categories/field-schema/fields-validator';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { FeedService } from '../feed/feed.service';
import { parseVariants } from '../media/media.types';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { isStaffRole, visibilityOf, type PostViewer } from '../posts/post-visibility';
import { PostNotFoundException } from '../posts/posts.exceptions';
import { PostsRepository, type PostMediaRow, type PostRow } from '../posts/posts.repository';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import { offeredChannels } from './contact-payload';
import type { PostDetail, PostDetailQuery } from './dto/engagement.dto';
import {
  EngagementRepository,
  type DetailRow,
  type EngagementCounts,
  type SellerRow,
} from './engagement.repository';
import { ShareService } from './share.service';

// settings-exempt: unit conversion
const SECONDS_PER_MINUTE = 60;

/**
 * GET /posts/:id/detail (ADR 036): everything a post page shows, in one
 * response — except the seller's number, which only POST /posts/:id/contact
 * returns (so every reveal is a counted lead and scraping this endpoint
 * harvests nothing).
 *
 * Read in the post's owning tenant as the caller (PostOwnershipService):
 * the same visibility as GET /posts/:id. Similar posts come from the feed's
 * ranking, cross-tenant by radius (CLAUDE.md rule 10).
 */
@Injectable()
export class PostDetailService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly posts: PostsRepository,
    private readonly repo: EngagementRepository,
    private readonly share: ShareService,
    private readonly feed: FeedService,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async detail(postId: string, query: PostDetailQuery): Promise<PostDetail> {
    const tenantId = await this.ownership.tenantOf(postId);
    if (!tenantId) throw new PostNotFoundException();
    const viewerAt =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : null;
    const [trustedMin, similarMax, similarRadiusKm, loginRequired] = await Promise.all([
      this.settings.get('trust_auto_approve_threshold', tenantId),
      this.settings.get('post_similar_max', tenantId),
      this.settings.get('post_similar_radius_km', tenantId),
      this.settings.get('require_login_for_contact', tenantId),
    ]);

    const signedIn = this.context.current()?.userId !== undefined;
    const found = await this.ownership.inTenant(tenantId, 'lookup', async ({ memberId, role }) => {
      const read = await this.tenantDb.transaction(
        async (tx) => {
          const row = await this.posts.findById(tx, postId);
          if (!row) return undefined;
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
          // A scrubbed post has nothing left to detail.
          if (visibility !== 'full') return undefined;
          return {
            row,
            viewer,
            detail: await this.repo.detail(tx, postId, viewerAt),
            media: await this.posts.mediaOf(tx, [postId]),
            seller: await this.repo.sellerCard(tx, postId, trustedMin),
            counts: viewer === 'public' ? undefined : await this.repo.counts(tx, postId),
            slug: await this.repo.tenantSlug(tx, tenantId),
            saved: signedIn ? await this.repo.isSaved(tx, postId) : false,
          };
        },
        { accessMode: 'read only' },
      );
      if (!read?.detail) return undefined;
      // Shareable only once public; a draft's link would lead nowhere.
      const shareable = read.row.status_code === 'live' || read.row.status_code === 'sold';
      const code = shareable && read.slug ? await this.share.codeFor(postId) : null;
      return { ...read, detail: read.detail, code };
    });
    if (!found) throw new PostNotFoundException();

    const { row, viewer, detail, media, seller, counts, slug, code, saved } = found;
    const similar =
      row.status_code === 'live' && row.lat !== null && row.lng !== null
        ? await this.feed.similarPosts({
            tenantId,
            origin: { lat: row.lat, lng: row.lng },
            radiusKm: similarRadiusKm,
            categoryId: row.category_id,
            excludeId: row.id,
            limit: similarMax,
          })
        : [];

    return {
      id: row.id,
      tenantId: row.tenant_id,
      status: row.status_code,
      isSold: row.status_code === 'sold',
      title: row.title,
      description: row.description,
      price: row.price,
      priceType: detail.price_type_code,
      currency: detail.currency,
      category: {
        id: row.category_id,
        slug: detail.category_slug,
        name: { bn: detail.category_name_bn, en: detail.category_name_en },
      },
      fieldSchemaVersion: row.field_schema_version,
      fields: this.fields(detail, row),
      media: this.media(media),
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
      area:
        detail.area_bn === null && detail.area_en === null
          ? null
          : { bn: detail.area_bn, en: detail.area_en },
      distanceMeters: detail.distance_m === null ? null : Math.round(detail.distance_m),
      seller: toSeller(seller),
      contact: {
        name: row.contact_name,
        channels: offeredChannels({
          hasPhone: row.contact_phone_e164 !== null,
          showPhone: row.show_phone,
          showWhatsapp: row.show_whatsapp,
        }),
        allowChat: row.allow_chat,
        loginRequired,
      },
      share: code && slug ? { code, url: this.share.urlFor(slug, code) } : null,
      similar,
      ...(viewer !== 'public' && counts ? { stats: toStats(counts) } : {}),
      isMine: viewer === 'owner',
      isSaved: saved,
      publishedAt: row.published_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      soldAt: row.sold_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /** Labels from the schema version the post pinned, never the category's current one. */
  private fields(detail: DetailRow, row: PostRow): PostDetail['fields'] {
    if (detail.json_schema === null || detail.json_schema === undefined) return [];
    return renderFields(
      {
        jsonSchema: parseFieldSchema(detail.json_schema),
        uiSchema: parseUiSchema(detail.ui_schema),
      },
      row.fields as FieldValues,
    ).map((field) => ({
      key: field.key,
      type: field.type,
      label: localized(field.label),
      value: field.value,
      ...(field.optionLabels ? { optionLabels: field.optionLabels.map(localized) } : {}),
    }));
  }

  private media(rows: readonly PostMediaRow[]): PostDetail['media'] {
    return rows.map((m) => {
      const variants =
        m.status_code === 'ready' && m.visibility_code === 'public'
          ? parseVariants(m.variants)
          : undefined;
      const variant = (name: 'thumb' | 'card' | 'full') => ({
        url: this.storage.getPublicUrl('media', variants![name].key),
        width: variants![name].width,
        height: variants![name].height,
      });
      return {
        id: m.media_asset_id,
        thumbhash: m.thumbhash,
        variants: variants
          ? { thumb: variant('thumb'), card: variant('card'), full: variant('full') }
          : null,
      };
    });
  }
}

function localized(text: { bn?: string | undefined; en?: string | undefined }): {
  bn: string | null;
  en: string | null;
} {
  return { bn: text.bn ?? null, en: text.en ?? null };
}

function toSeller(row: SellerRow | undefined): PostDetail['seller'] {
  if (!row) return { name: null, memberSince: null, badges: [], store: null, responseHint: null };
  const badges: PostDetail['seller']['badges'] = [];
  if (row.trusted) badges.push('trusted');
  if (row.phone_verified) badges.push('phone_verified');
  if (row.store_verified) badges.push('verified_store');
  return {
    name: row.display_name,
    memberSince: row.member_since?.toISOString() ?? null,
    badges,
    store:
      row.store_id && row.store_slug
        ? {
            id: row.store_id,
            slug: row.store_slug,
            name: { bn: row.store_name_bn, en: row.store_name_en },
            verified: row.store_verified ?? false,
          }
        : null,
    responseHint:
      row.response_rate_pct === null && row.median_response_seconds === null
        ? null
        : {
            ratePercent: row.response_rate_pct,
            medianMinutes:
              row.median_response_seconds === null
                ? null
                : Math.ceil(row.median_response_seconds / SECONDS_PER_MINUTE),
          },
  };
}

function toStats(counts: EngagementCounts): NonNullable<PostDetail['stats']> {
  return {
    views: counts.views,
    contacts: {
      call: counts.calls,
      whatsapp: counts.whatsapp,
      sms: counts.sms,
      total: counts.calls + counts.whatsapp + counts.sms,
    },
    saves: counts.saves,
  };
}
