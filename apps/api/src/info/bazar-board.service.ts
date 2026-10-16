import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { directionOf, fillTrend, previousDate, trendDates, type DayPrice } from './bazar-trend';
import type { BazarBoard, BazarBoardItem } from './dto/info.dto';
import { BazarBoardDisabledException, InfoAreaRequiredException } from './info.exceptions';
import { InfoRepository, type BazarBoardKind } from './info.repository';

/**
 * THE price board of an area (ADR 064): its catalogue (bazar_catalogue), each
 * item's today / yesterday / trend, the up-down arrow, the stale flag and the
 * sponsor. The public board and the feed's bazar card both read it here.
 */
@Injectable()
export class BazarBoardService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: InfoRepository,
    private readonly settings: SettingsService,
  ) {}

  async board(kind: BazarBoardKind = 'bazar'): Promise<BazarBoard> {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new InfoAreaRequiredException();
    if (kind === 'agri' && !(await this.settings.get('agri_services_enabled', tenantId))) {
      throw new BazarBoardDisabledException();
    }
    const trendDays = await this.settings.get('bazar_trend_days');
    return this.tenantDb.transaction((tx) => this.read(tx, tenantId, trendDays, kind), {
      accessMode: 'read only',
    });
  }

  private async read(
    tx: DatabaseTransaction,
    tenantId: string,
    trendDays: number,
    kind: BazarBoardKind,
  ): Promise<BazarBoard> {
    const today = await this.repo.localToday(tx, tenantId);
    const dates = trendDates(today, trendDays);
    const [catalogue, prices, lastUpdated, sponsor] = await Promise.all([
      this.repo.catalogue(tx, tenantId, kind),
      this.repo.dayPrices(tx, dates[0]!, today),
      this.repo.lastPriceDate(tx, kind),
      // The sponsor slot is the bazar board's (display only, ADR 064).
      kind === 'bazar' ? this.repo.currentSponsor(tx, today) : Promise.resolve(undefined),
    ]);
    const byItem = new Map<string, DayPrice[]>();
    for (const p of prices) {
      const key = `${p.commodity_id}:${p.unit_code}`;
      const list = byItem.get(key) ?? [];
      list.push({ date: p.price_date, min: p.min_price, max: p.max_price });
      byItem.set(key, list);
    }
    const yesterday = previousDate(today);
    const items: BazarBoardItem[] = catalogue.map((c) => {
      const trend = fillTrend(dates, byItem.get(`${c.commodity_id}:${c.unit_code}`) ?? []);
      const at = (d: string) => {
        const p = trend.find((t) => t?.date === d);
        return p ? { min: p.min, max: p.max } : null;
      };
      const todayPrice = at(today);
      const yesterdayPrice = at(yesterday);
      return {
        commodityId: c.commodity_id,
        code: c.code,
        name: { bn: c.name_bn, en: c.name_en },
        group: c.group_code,
        unit: c.unit_code,
        today: todayPrice,
        yesterday: yesterdayPrice,
        direction: directionOf(todayPrice, yesterdayPrice),
        trend,
      };
    });
    return {
      date: today,
      lastUpdated,
      isStale: lastUpdated !== today,
      trendDays,
      sponsor: sponsor
        ? {
            name: { bn: sponsor.name_bn, en: sponsor.name_en },
            tagline: sponsor.tagline_bn,
            linkUrl: sponsor.link_url,
          }
        : null,
      items,
    };
  }
}
