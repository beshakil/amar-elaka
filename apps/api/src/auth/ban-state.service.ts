import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CacheService } from '../cache/cache.service';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';

export const BAN_SEVERITIES = ['restricted', 'banned', 'terminated'] as const;
export type BanSeverity = (typeof BAN_SEVERITIES)[number];

export interface BanState {
  severity: BanSeverity;
  /** area: a ban in this area; platform: the global blacklist. */
  source: 'area' | 'platform';
  expiresAt: string | null;
}

const ROW = z.object({
  severity_code: z.enum(BAN_SEVERITIES),
  source: z.enum(['area', 'platform']),
  expires_at: z.union([z.date(), z.string()]).nullable(),
});
const CACHED = z.object({
  state: z
    .object({
      severity: z.enum(BAN_SEVERITIES),
      source: z.enum(['area', 'platform']),
      expiresAt: z.string().nullable(),
    })
    .nullable(),
});

// settings-exempt: milliseconds in a second, a unit conversion
const MS_PER_SECOND = 1000;

/**
 * A person's ban state in an area — the one rule is my_ban_state() (0059):
 * an active global blacklist entry, else an active ban in that area. Read on
 * every authenticated request, so it is cached in Redis per (user, area) for
 * ban_state_cache_seconds, never beyond the ban's own end; any change bumps
 * the user's version key, so a new ban or a lift bites on the next request.
 */
@Injectable()
export class BanStateService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly cache: CacheService,
    private readonly settings: SettingsService,
  ) {}

  /** Redis down: read the database every time rather than fail the request (the rule must still bite). */
  async stateFor(userId: string, tenantId: string): Promise<BanState | null> {
    const key = await this.quietly(async () => {
      const version = (await this.cache.getText(versionKey(userId))) ?? '0';
      return `ban:state:${userId}:${tenantId}:${version}`;
    });
    if (key) {
      const cached = CACHED.safeParse(await this.quietly(() => this.cache.get<unknown>(key)));
      if (cached.success) return cached.data.state;
    }

    const state = await this.read(userId, tenantId);
    if (key) {
      const ttl = await this.settings.get('ban_state_cache_seconds');
      const untilEnd = state?.expiresAt
        ? Math.floor((new Date(state.expiresAt).getTime() - Date.now()) / MS_PER_SECOND)
        : ttl;
      const seconds = Math.min(ttl, untilEnd);
      if (seconds > 0) await this.quietly(() => this.cache.set(key, { state }, seconds));
    }
    return state;
  }

  /**
   * Any ban, lift, appeal decision or blacklist change for this person. If
   * Redis is down the old entry can't be read either, and it ages out
   * within ban_state_cache_seconds regardless.
   */
  async invalidate(userId: string): Promise<void> {
    const ttl = await this.settings.get('ban_state_cache_seconds');
    await this.quietly(() => this.cache.setText(versionKey(userId), randomUUID(), ttl));
  }

  private async quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch {
      return undefined;
    }
  }

  private read(userId: string, tenantId: string): Promise<BanState | null> {
    return this.context.run({ tenantId, userId, role: 'member' }, () =>
      this.tenantDb.transaction(
        async (tx) => {
          const [row] = z
            .array(ROW)
            .parse([
              ...(await tx.execute(
                sql`select severity_code, source, expires_at from public.my_ban_state()`,
              )),
            ]);
          if (!row) return null;
          return {
            severity: row.severity_code,
            source: row.source,
            expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
          };
        },
        { accessMode: 'read only' },
      ),
    );
  }
}

const versionKey = (userId: string) => `ban:version:${userId}`;
