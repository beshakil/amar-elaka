import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { storedSavedSearch, type StoredSavedSearch } from './saved-search-criteria';

/**
 * saved_searches and saved_search_matches. Two kinds of reads, never mixed:
 *  - the owner's, through the G-OWNER policies (the API, in the user's context);
 *  - the worker's, as `system` (matching, notifying, pausing).
 * No SELECT *, every row parsed with zod.
 */

const COLUMNS = sql.raw(`
  s.id, s.user_id, s.name, s.query_text, s.category_id, c.slug as category_slug, s.filters,
  s.price_min::text as price_min, s.price_max::text as price_max,
  st_y(s.center::geometry) as lat, st_x(s.center::geometry) as lng, s.radius_km::text as radius_km,
  s.alert_frequency_code, s.is_active, s.paused_at, s.last_alerted_at, s.last_engaged_at,
  s.notify_day::text as notify_day, s.notify_count, s.created_at`);

const FROM = sql.raw(
  `public.saved_searches s left join public.categories c on c.id = s.category_id`,
);

/** Active: switched on, not auto-paused, not deleted. */
const ACTIVE = sql.raw(`s.is_active and s.paused_at is null and s.deleted_at is null`);

const nilUuid = '00000000-0000-0000-0000-000000000000';

export interface SavedSearchWrite {
  name: string;
  queryText: string | null;
  categoryId: string | null;
  fields: Record<string, unknown>;
  priceMin: string | null;
  priceMax: string | null;
  center: { lat: number; lng: number };
  radiusKm: number;
  frequency: 'instant' | 'daily' | 'off';
}

export interface NewPost {
  id: string;
  tenant_id: string;
  published_at: Date;
}

export interface DueSearch {
  id: string;
  user_id: string;
  name: string;
  alert_frequency_code: 'instant' | 'daily' | 'off';
  last_alerted_at: Date | null;
  notify_day: string | null;
  notify_count: number;
  /** Unnotified, unseen matches of posts still live. */
  pending: number;
  /** The newest of them: everything up to it is covered by this notification. */
  max_match_id: string;
}

function point(center: { lat: number; lng: number }): SQL {
  return sql`st_setsrid(st_makepoint(${center.lng}, ${center.lat}), 4326)::geography`;
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

@Injectable()
export class SavedSearchesRepository {
  // ---- the owner's side (G-OWNER policies) ---------------------------------

  /**
   * Serialises one user's changes that count against saved_search_max_active,
   * so two parallel creates can't both take the last slot.
   */
  async lockUser(tx: DatabaseTransaction, userId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`saved_searches:${userId}`}, 0))`,
    );
  }

  async countActive(tx: DatabaseTransaction, userId: string, exceptId?: string): Promise<number> {
    const rows = await tx.execute(sql`
      select count(*)::integer as n from ${FROM}
      where s.user_id = ${userId}::uuid and ${ACTIVE}
        and (${exceptId ?? null}::uuid is null or s.id <> ${exceptId ?? null}::uuid)`);
    return z.array(z.object({ n: z.number() })).parse([...rows])[0]!.n;
  }

  async insert(tx: DatabaseTransaction, userId: string, w: SavedSearchWrite): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.saved_searches
        (user_id, name, query_text, category_id, filters, price_min, price_max, center, radius_km,
         alert_frequency_code, last_engaged_at)
      values (${userId}::uuid, ${w.name}, ${w.queryText}, ${w.categoryId}::uuid,
              ${JSON.stringify({ fields: w.fields })}::jsonb, ${w.priceMin}::numeric,
              ${w.priceMax}::numeric, ${point(w.center)}, ${w.radiusKm}, ${w.frequency}, now())
      returning id`);
    return z.array(z.object({ id: z.string() })).parse([...rows])[0]!.id;
  }

  async update(
    tx: DatabaseTransaction,
    id: string,
    w: SavedSearchWrite & { active: boolean; resume: boolean },
  ): Promise<void> {
    await tx.execute(sql`
      update public.saved_searches set
        name = ${w.name}, query_text = ${w.queryText}, category_id = ${w.categoryId}::uuid,
        filters = ${JSON.stringify({ fields: w.fields })}::jsonb,
        price_min = ${w.priceMin}::numeric, price_max = ${w.priceMax}::numeric,
        center = ${point(w.center)}, radius_km = ${w.radiusKm},
        alert_frequency_code = ${w.frequency}, is_active = ${w.active},
        -- Resuming clears an auto-pause and counts as opening it.
        paused_at = case when ${w.resume} then null else paused_at end,
        last_engaged_at = now()
      where id = ${id}::uuid and deleted_at is null`);
  }

  async softDelete(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.saved_searches set deleted_at = now(), is_active = false
      where id = ${id}::uuid and deleted_at is null
      returning id`);
    return [...rows].length > 0;
  }

  /** The caller's own searches (RLS), not deleted, newest first; or one of them. */
  async list(tx: DatabaseTransaction, userId: string, id?: string): Promise<StoredSavedSearch[]> {
    const rows = await tx.execute(sql`
      select ${COLUMNS} from ${FROM}
      where s.user_id = ${userId}::uuid and s.deleted_at is null
        and (${id ?? null}::uuid is null or s.id = ${id ?? null}::uuid)
      order by s.id desc`);
    return z.array(storedSavedSearch).parse([...rows]);
  }

  /** Unseen matches per search: the badge. */
  async newCounts(
    tx: DatabaseTransaction,
    searchIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (searchIds.length === 0) return new Map();
    const rows = await tx.execute(sql`
      select saved_search_id, count(*)::integer as n from public.saved_search_matches
      where saved_search_id = any (${uuidArray(searchIds)}) and seen_at is null
      group by saved_search_id`);
    return new Map(
      z
        .array(z.object({ saved_search_id: z.string(), n: z.number() }))
        .parse([...rows])
        .map((r) => [r.saved_search_id, r.n]),
    );
  }

  async unseenMatches(
    tx: DatabaseTransaction,
    searchId: string,
    limit: number,
  ): Promise<{ id: string; post_id: string; post_tenant_id: string }[]> {
    const rows = await tx.execute(sql`
      select id, post_id, post_tenant_id from public.saved_search_matches
      where saved_search_id = ${searchId}::uuid and seen_at is null
      order by id desc
      limit ${limit}`);
    return z
      .array(z.object({ id: z.string(), post_id: z.string(), post_tenant_id: z.string() }))
      .parse([...rows]);
  }

  /** Opening the results: they stop being new, and the search counts as opened. */
  async markSeen(tx: DatabaseTransaction, searchId: string, matchIds: readonly string[]) {
    if (matchIds.length > 0) {
      await tx.execute(sql`
        update public.saved_search_matches set seen_at = now()
        where id = any (${uuidArray(matchIds)}) and seen_at is null`);
    }
    await tx.execute(sql`
      update public.saved_searches set last_engaged_at = now() where id = ${searchId}::uuid`);
  }

  // ---- the matcher (system) -----------------------------------------------

  /** Tenants whose posts can be public; each gets a watermark on first sight. */
  async matchableTenants(tx: DatabaseTransaction): Promise<string[]> {
    const rows = await tx.execute(sql`
      select id from public.tenants where status_code in ('active', 'past_due') order by id`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  /**
   * A tenant seen for the first time starts at "now": saved searches alert
   * on what is published from here on, never on the whole back catalogue.
   */
  async ensureWatermark(tx: DatabaseTransaction, tenantId: string, graceSeconds: number) {
    await tx.execute(sql`
      insert into public.saved_search_watermarks (tenant_id, last_published_at, last_post_id)
      values (${tenantId}::uuid, now() - make_interval(secs => ${graceSeconds}), ${nilUuid}::uuid)
      on conflict (tenant_id) do nothing`);
  }

  /**
   * The tenant's next posts past its watermark, oldest first: live, and live
   * for at least the grace period, so the search index already has them.
   */
  async newPosts(
    tx: DatabaseTransaction,
    tenantId: string,
    graceSeconds: number,
    limit: number,
  ): Promise<NewPost[]> {
    const rows = await tx.execute(sql`
      select p.id, p.tenant_id, p.published_at
      from public.posts p
      join public.saved_search_watermarks w on w.tenant_id = p.tenant_id
      where p.tenant_id = ${tenantId}::uuid
        and p.status_code = 'live' and p.deleted_at is null and p.scrubbed_at is null
        and not p.hidden_by_owner
        and p.published_at is not null
        and p.published_at <= now() - make_interval(secs => ${graceSeconds})
        and (p.published_at, p.id) > (w.last_published_at, w.last_post_id)
      order by p.published_at, p.id
      limit ${limit}`);
    return z
      .array(z.object({ id: z.string(), tenant_id: z.string(), published_at: z.coerce.date() }))
      .parse([...rows]);
  }

  async advanceWatermark(tx: DatabaseTransaction, tenantId: string, last: NewPost): Promise<void> {
    await tx.execute(sql`
      update public.saved_search_watermarks
      set last_published_at = ${last.published_at.toISOString()}::timestamptz,
          last_post_id = ${last.id}::uuid
      where tenant_id = ${tenantId}::uuid`);
  }

  /**
   * Which active searches each new post could concern: those whose circle
   * contains the post's point (the same point the index uses for `_geo`:
   * the post's pin, else its locality's centre, else its area's centroid),
   * minus the author's own searches. Only a narrowing — whether the post
   * matches is decided by SearchMatcher, radius included.
   */
  async candidatePairs(
    tx: DatabaseTransaction,
    postIds: readonly string[],
  ): Promise<{ search_id: string; post_id: string }[]> {
    if (postIds.length === 0) return [];
    const rows = await tx.execute(sql`
      with new_posts as (
        select p.id, p.tenant_id, p.author_member_id,
               coalesce(p.location, l.center, ga.centroid) as pt
        from public.posts p
        left join public.localities l
          on l.tenant_id = p.tenant_id and l.id = p.locality_id and l.deleted_at is null
        left join public.geo_areas ga on ga.id = coalesce(p.geo_area_id, p.geo_area_id_coarse)
        where p.id = any (${uuidArray(postIds)})
      )
      select s.id as search_id, np.id as post_id
      from new_posts np
      join public.saved_searches s on st_dwithin(s.center, np.pt, s.radius_km * 1000)
      left join public.tenant_members m on m.tenant_id = np.tenant_id and m.id = np.author_member_id
      where ${ACTIVE} and np.pt is not null
        and s.user_id is distinct from m.user_id
      order by s.id, np.id`);
    return z.array(z.object({ search_id: z.string(), post_id: z.string() })).parse([...rows]);
  }

  async loadForMatching(
    tx: DatabaseTransaction,
    searchIds: readonly string[],
  ): Promise<StoredSavedSearch[]> {
    if (searchIds.length === 0) return [];
    const rows = await tx.execute(sql`
      select ${COLUMNS} from ${FROM}
      where s.id = any (${uuidArray(searchIds)}) and ${ACTIVE}`);
    return z.array(storedSavedSearch).parse([...rows]);
  }

  async insertMatches(
    tx: DatabaseTransaction,
    rows: readonly { searchId: string; userId: string; postId: string; postTenantId: string }[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const values = sql.join(
      rows.map(
        (r) =>
          sql`(${r.searchId}::uuid, ${r.userId}::uuid, ${r.postId}::uuid, ${r.postTenantId}::uuid)`,
      ),
      sql`, `,
    );
    const inserted = await tx.execute(sql`
      insert into public.saved_search_matches (saved_search_id, user_id, post_id, post_tenant_id)
      values ${values}
      on conflict (saved_search_id, post_id) do nothing
      returning id`);
    return [...inserted].length;
  }

  // ---- the notifier (system) ----------------------------------------------

  /** Active, notifying searches with new matches not notified yet, oldest search first. */
  async withPendingMatches(tx: DatabaseTransaction, limit: number): Promise<DueSearch[]> {
    const rows = await tx.execute(sql`
      select s.id, s.user_id, s.name, s.alert_frequency_code, s.last_alerted_at,
             s.notify_day::text as notify_day, s.notify_count,
             pending.n as pending, pending.max_id as max_match_id
      from public.saved_searches s
      cross join lateral (
        select count(*)::integer as n, max(m.id::text) as max_id
        from public.saved_search_matches m
        where m.saved_search_id = s.id and m.notified_at is null and m.seen_at is null
      ) pending
      where ${ACTIVE} and s.alert_frequency_code in ('instant', 'daily') and pending.n > 0
      order by s.id
      limit ${limit}`);
    return z
      .array(
        z.object({
          id: z.string(),
          user_id: z.string(),
          name: z.string(),
          alert_frequency_code: z.enum(['instant', 'daily', 'off']),
          last_alerted_at: z.coerce.date().nullable(),
          notify_day: z.string().nullable(),
          notify_count: z.coerce.number().int(),
          pending: z.number().int(),
          max_match_id: z.string(),
        }),
      )
      .parse([...rows]);
  }

  /**
   * The notification went out: the matches it covered are notified, and the
   * search's daily count moves on (a new Dhaka day starts again at 1).
   */
  async markNotified(
    tx: DatabaseTransaction,
    searchId: string,
    maxMatchId: string,
    dhakaDay: string,
  ): Promise<void> {
    await tx.execute(sql`
      update public.saved_search_matches set notified_at = now()
      where saved_search_id = ${searchId}::uuid and notified_at is null and seen_at is null
        and id <= ${maxMatchId}::uuid`);
    await tx.execute(sql`
      update public.saved_searches
      set last_alerted_at = now(),
          notify_count = case when notify_day = ${dhakaDay}::date then notify_count + 1 else 1 end,
          notify_day = ${dhakaDay}::date
      where id = ${searchId}::uuid`);
  }

  // ---- auto-pause (system) ------------------------------------------------

  /** Pauses active searches not opened for `idleDays`; returns them for the final notice. */
  async pauseIdle(
    tx: DatabaseTransaction,
    idleDays: number,
    limit: number,
  ): Promise<{ id: string; user_id: string; name: string }[]> {
    const rows = await tx.execute(sql`
      update public.saved_searches x set paused_at = now()
      where x.id in (
        select s.id from public.saved_searches s
        where ${ACTIVE}
          and coalesce(s.last_engaged_at, s.created_at) < now() - make_interval(days => ${idleDays})
        order by s.id
        limit ${limit}
        for update skip locked
      )
      returning x.id, x.user_id, x.name`);
    return z
      .array(z.object({ id: z.string(), user_id: z.string(), name: z.string() }))
      .parse([...rows]);
  }
}
