import { Inject, Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { parseVariants } from '../media/media.types';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { SettingsService } from '../settings/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.ports';
import type {
  FollowResult,
  SavedItem,
  SavedItemType,
  SavedPage,
  SavedQuery,
  SaveResult,
} from './dto/saved.dto';
import {
  FollowOwnStoreException,
  SaveOwnItemException,
  SavedTargetNotFoundException,
  StoreNotFoundException,
} from './saved.exceptions';
import { SavedRepository, type SavedRow } from './saved.repository';

/**
 * Saved items and store follows (Q25, §13.29, ADR 037).
 *
 * A save or follow is a row in the TARGET's tenant, written there as the
 * caller (PostOwnershipService.inTenant, 'lookup': no membership is created
 * just to save something). The user's own rows are readable and deletable
 * from any tenant, so the list is one list across tenants and unsave/unfollow
 * need no lookup. Counters (posts.saved_count, stores.follower_count) are
 * kept by triggers.
 */
@Injectable()
export class SavedService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly repo: SavedRepository,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /** Saves what the public can see; your own post or store is refused. Idempotent. */
  async save(itemType: SavedItemType, itemId: string): Promise<SaveResult> {
    this.requireUserId();
    const tenantId = await this.readOnly((tx) => this.repo.itemTenantOf(tx, itemType, itemId));
    if (!tenantId) throw new SavedTargetNotFoundException(itemType);
    const saved = await this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(async (tx) => {
        const target = await this.repo.target(tx, itemType, itemId);
        if (target?.own) throw new SaveOwnItemException();
        if (!target?.public) throw new SavedTargetNotFoundException(itemType);
        return this.repo.save(tx, itemType, itemId);
      }),
    );
    return { itemType, itemId, savedAt: saved.savedAt.toISOString(), created: saved.created };
  }

  /** Idempotent: removing what isn't saved is fine too. */
  async unsave(itemType: SavedItemType, itemId: string): Promise<void> {
    this.requireUserId();
    await this.tenantDb.transaction((tx) => this.repo.unsave(tx, itemType, itemId));
  }

  /** GET /saved: newest first, every saved item with its state — none ever silently dropped. */
  async list(query: SavedQuery): Promise<SavedPage> {
    this.requireUserId();
    const [pageDefault, pageMax] = await Promise.all([
      this.settings.get('saved_page_size_default'),
      this.settings.get('saved_page_size_max'),
    ]);
    const limit = Math.min(query.limit ?? pageDefault, pageMax);
    const rows = await this.readOnly((tx) =>
      this.repo.mySaved(tx, query.type ?? null, query.cursor ?? null, limit + 1),
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => this.toItem(row)),
      nextCursor: rows.length > limit ? (page.at(-1)?.save_id ?? null) : null,
    };
  }

  /** Follows an active store (not your own). Idempotent. */
  async follow(storeId: string): Promise<FollowResult> {
    this.requireUserId();
    const tenantId = await this.readOnly((tx) => this.repo.itemTenantOf(tx, 'store', storeId));
    if (!tenantId) throw new StoreNotFoundException();
    const followerCount = await this.ownership.inTenant(tenantId, 'lookup', () =>
      this.tenantDb.transaction(async (tx) => {
        const target = await this.repo.target(tx, 'store', storeId);
        if (target?.own) throw new FollowOwnStoreException();
        if (!target?.public) throw new StoreNotFoundException();
        await this.repo.follow(tx, storeId);
        return this.repo.followerCount(tx, storeId);
      }),
    );
    return { storeId, following: true, followerCount: followerCount ?? null };
  }

  /** Idempotent; the count is null when the store is no longer public. */
  async unfollow(storeId: string): Promise<FollowResult> {
    this.requireUserId();
    await this.tenantDb.transaction((tx) => this.repo.unfollow(tx, storeId));
    const tenantId = await this.readOnly((tx) => this.repo.itemTenantOf(tx, 'store', storeId));
    const followerCount = tenantId
      ? await this.ownership.inTenant(tenantId, 'lookup', () =>
          this.readOnly((tx) => this.repo.followerCount(tx, storeId)),
        )
      : undefined;
    return { storeId, following: false, followerCount: followerCount ?? null };
  }

  private toItem(row: SavedRow): SavedItem {
    const variants = parseVariants(row.cover_variants);
    return {
      itemType: row.item_type,
      itemId: row.item_id,
      tenantId: row.tenant_id,
      savedAt: row.saved_at.toISOString(),
      state: row.state,
      name:
        row.name_bn === null && row.name_en === null ? null : { bn: row.name_bn, en: row.name_en },
      slug: row.slug,
      price: row.price,
      priceType: row.price_type_code,
      cover: variants
        ? {
            url: this.storage.getPublicUrl('media', variants.card.key),
            thumbhash: row.cover_thumbhash,
          }
        : null,
      area:
        row.area_bn === null && row.area_en === null ? null : { bn: row.area_bn, en: row.area_en },
    };
  }

  private requireUserId(): string {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }

  private readOnly<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }
}
