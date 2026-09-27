import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { SAVED_ITEM_STATES, SAVED_ITEM_TYPES, type SavedItemType } from './dto/saved.dto';

/** Each item type's table and target column (constants, never input). */
const SAVE_TABLES: Record<SavedItemType, { table: SQL; column: SQL }> = {
  post: { table: sql.raw('public.saved_posts'), column: sql.raw('post_id') },
  place: { table: sql.raw('public.saved_places'), column: sql.raw('place_id') },
  store: { table: sql.raw('public.saved_stores'), column: sql.raw('store_id') },
};

const SAVED_ROW = z.object({
  save_id: z.string(),
  item_type: z.enum(SAVED_ITEM_TYPES),
  item_id: z.string(),
  tenant_id: z.string(),
  saved_at: z.coerce.date(),
  state: z.enum(SAVED_ITEM_STATES),
  name_bn: z.string().nullable(),
  name_en: z.string().nullable(),
  slug: z.string().nullable(),
  price: z.string().nullable(),
  price_type_code: z.string().nullable(),
  cover_variants: z.unknown(),
  cover_thumbhash: z.string().nullable(),
  area_bn: z.string().nullable(),
  area_en: z.string().nullable(),
});
export type SavedRow = z.infer<typeof SAVED_ROW>;

/** What saving needs to know about a target, as the caller sees it. */
export interface SaveTarget {
  /** Open to the public: a live/sold post, a published or temporarily closed place, an active store. */
  public: boolean;
  /** The caller's own post, or a store they own. */
  own: boolean;
}

/**
 * SQL for saved items and store follows (ADR 037). Writes run in the target's
 * owning tenant as the caller; the saved_* policies let a user read and delete
 * their own rows from any tenant context (§13.29).
 */
@Injectable()
export class SavedRepository {
  async itemTenantOf(
    tx: DatabaseTransaction,
    itemType: SavedItemType,
    itemId: string,
  ): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select public.item_tenant_of(${itemType}, ${itemId}::uuid) as tenant_id`,
    );
    return (
      z.array(z.object({ tenant_id: z.string().nullable() })).parse([...rows])[0]?.tenant_id ??
      undefined
    );
  }

  /** The target as the caller's own policies show it; undefined when they can't see it at all. */
  async target(
    tx: DatabaseTransaction,
    itemType: SavedItemType,
    itemId: string,
  ): Promise<SaveTarget | undefined> {
    const query =
      itemType === 'post'
        ? sql`
            select (status_code in ('live', 'sold') and not hidden_by_owner
                    and deleted_at is null and scrubbed_at is null) as public,
                   coalesce(author_member_id = public.current_member_id(), false) as own
            from public.posts where id = ${itemId}::uuid`
        : itemType === 'place'
          ? sql`
            select (status_code in ('published', 'temporarily_closed') and deleted_at is null) as public,
                   false as own
            from public.places where id = ${itemId}::uuid`
          : sql`
            select (status_code = 'active' and deleted_at is null) as public,
                   coalesce(owner_member_id = public.current_member_id(), false) as own
            from public.stores where id = ${itemId}::uuid`;
    const rows = await tx.execute(query);
    return z
      .array(z.object({ public: z.boolean(), own: z.boolean() }))
      .max(1)
      .parse([...rows])[0];
  }

  /** Saves it (no-op when already saved); returns when it was saved and whether just now. */
  async save(
    tx: DatabaseTransaction,
    itemType: SavedItemType,
    itemId: string,
  ): Promise<{ savedAt: Date; created: boolean }> {
    const { table, column } = SAVE_TABLES[itemType];
    const inserted = await tx.execute(sql`
      insert into ${table} (user_id, ${column})
      values (public.current_user_id(), ${itemId}::uuid)
      on conflict do nothing
      returning created_at`);
    const created = z.array(z.object({ created_at: z.coerce.date() })).parse([...inserted])[0];
    if (created) return { savedAt: created.created_at, created: true };
    const existing = await tx.execute(sql`
      select created_at from ${table}
      where user_id = public.current_user_id() and ${column} = ${itemId}::uuid`);
    const [row] = z
      .array(z.object({ created_at: z.coerce.date() }))
      .length(1)
      .parse([...existing]);
    return { savedAt: row!.created_at, created: false };
  }

  async unsave(tx: DatabaseTransaction, itemType: SavedItemType, itemId: string): Promise<void> {
    const { table, column } = SAVE_TABLES[itemType];
    await tx.execute(sql`
      delete from ${table} where user_id = public.current_user_id() and ${column} = ${itemId}::uuid`);
  }

  /** Whether the caller has saved this post (own rows are visible in any context). */
  async isSaved(
    tx: DatabaseTransaction,
    itemType: SavedItemType,
    itemId: string,
  ): Promise<boolean> {
    const { table, column } = SAVE_TABLES[itemType];
    const rows = await tx.execute(sql`
      select exists (
        select 1 from ${table} where user_id = public.current_user_id() and ${column} = ${itemId}::uuid
      ) as saved`);
    return z
      .array(z.object({ saved: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!.saved;
  }

  /** my_saved_items (0032): the caller's saves across tenants, newest first. */
  async mySaved(
    tx: DatabaseTransaction,
    itemType: SavedItemType | null,
    before: string | null,
    limit: number,
  ): Promise<SavedRow[]> {
    const rows = await tx.execute(sql`
      select save_id, item_type, item_id, tenant_id, saved_at, state, name_bn, name_en, slug,
             price, price_type_code, cover_variants, cover_thumbhash, area_bn, area_en
      from public.my_saved_items(${itemType}, ${before}::uuid, ${limit})`);
    return z.array(SAVED_ROW).parse([...rows]);
  }

  async follow(tx: DatabaseTransaction, storeId: string): Promise<void> {
    await tx.execute(sql`
      insert into public.store_follows (user_id, store_id)
      values (public.current_user_id(), ${storeId}::uuid)
      on conflict do nothing`);
  }

  async unfollow(tx: DatabaseTransaction, storeId: string): Promise<void> {
    await tx.execute(sql`
      delete from public.store_follows
      where user_id = public.current_user_id() and store_id = ${storeId}::uuid`);
  }

  /** The store's follower_count, when the caller can see the store. */
  async followerCount(tx: DatabaseTransaction, storeId: string): Promise<number | undefined> {
    const rows = await tx.execute(
      sql`select follower_count from public.stores where id = ${storeId}::uuid`,
    );
    return z
      .array(z.object({ follower_count: z.number() }))
      .max(1)
      .parse([...rows])[0]?.follower_count;
  }
}
