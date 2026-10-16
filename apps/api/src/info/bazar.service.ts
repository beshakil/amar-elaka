import { Injectable } from '@nestjs/common';
import { isStaffRole } from '../posts/post-visibility';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { previousDate, shiftDate } from './bazar-trend';
import type {
  BazarCatalogue,
  BazarCatalogueInput,
  BazarEntryInput,
  BazarEntrySheet,
  BazarSponsorAdmin,
  BazarSponsorInput,
} from './dto/info.dto';
import {
  BazarEntryRefusedException,
  InfoAreaRequiredException,
  InfoStaffOnlyException,
  mapInfoErrors,
} from './info.exceptions';
import { InfoRepository, type BazarBoardKind } from './info.repository';

/**
 * The area team's side of the bazar board (ADR 064): the fast entry sheet
 * (one screen, yesterday's figure prefilled), the catalogue and the sponsor
 * slot. The public board is BazarBoardService.
 */
@Injectable()
export class BazarService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: InfoRepository,
    private readonly settings: SettingsService,
  ) {}

  /** Staff or field agents: what to fill in for `date` (default today). */
  async entrySheet(
    date: string | undefined,
    board: BazarBoardKind = 'bazar',
  ): Promise<BazarEntrySheet> {
    const tenantId = this.requireRole('team');
    const backdate = await this.settings.get('bazar_entry_backdate_days', tenantId);
    return this.tenantDb.transaction(
      async (tx) => {
        const today = await this.repo.localToday(tx, tenantId);
        const earliest = shiftDate(today, -backdate);
        const day = date ?? today;
        if (day > today || day < earliest) throw new BazarEntryRefusedException('date');
        const previous = previousDate(day);
        const [catalogue, prices] = await Promise.all([
          this.repo.catalogue(tx, tenantId, board),
          this.repo.dayPrices(tx, previous, day),
        ]);
        const at = (commodityId: string, unit: string, d: string) => {
          const p = prices.find(
            (x) => x.commodity_id === commodityId && x.unit_code === unit && x.price_date === d,
          );
          return p ? { min: p.min_price, max: p.max_price } : null;
        };
        return {
          date: day,
          earliestDate: earliest,
          items: catalogue.map((c) => ({
            commodityId: c.commodity_id,
            code: c.code,
            name: { bn: c.name_bn, en: c.name_en },
            group: c.group_code,
            unit: c.unit_code,
            entered: at(c.commodity_id, c.unit_code, day),
            previous: at(c.commodity_id, c.unit_code, previous),
          })),
        };
      },
      { accessMode: 'read only' },
    );
  }

  /** Publishes the sheet in one go (bazar_enter_prices: role, date and items are checked there). */
  async enter(input: BazarEntryInput): Promise<{ saved: number }> {
    this.requireRole('team');
    const saved = await mapInfoErrors(() =>
      this.tenantDb.transaction((tx) =>
        this.repo.enterPrices(
          tx,
          input.date,
          input.items.map((i) => ({
            commodity_id: i.commodityId,
            unit_code: i.unitCode,
            min_price: i.minPrice,
            max_price: i.maxPrice,
          })),
        ),
      ),
    );
    return { saved };
  }

  async catalogue(): Promise<BazarCatalogue> {
    this.requireRole('staff');
    const rows = await this.tenantDb.transaction((tx) => this.repo.commodities(tx), {
      accessMode: 'read only',
    });
    return {
      customised: rows.some((r) => r.selected_unit !== null),
      commodities: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: { bn: r.name_bn, en: r.name_en },
        group: r.group_code,
        defaultUnit: r.default_unit_code,
        selected:
          r.selected_unit === null
            ? null
            : { unit: r.selected_unit, sortOrder: r.selected_sort ?? 0 },
      })),
    };
  }

  async setCatalogue(input: BazarCatalogueInput): Promise<void> {
    this.requireRole('staff');
    await this.tenantDb.transaction((tx) => this.repo.replaceCatalogue(tx, input));
  }

  async sponsor(): Promise<BazarSponsorAdmin> {
    this.requireRole('staff');
    const row = await this.tenantDb.transaction((tx) => this.repo.latestSponsor(tx), {
      accessMode: 'read only',
    });
    return {
      sponsor: row
        ? {
            id: row.id,
            nameBn: row.name_bn,
            nameEn: row.name_en,
            taglineBn: row.tagline_bn,
            linkUrl: row.link_url,
            startsOn: row.starts_on,
            endsOn: row.ends_on,
          }
        : null,
    };
  }

  /** Display only (selling the slot is week 16); null clears it. */
  async setSponsor(input: BazarSponsorInput | null): Promise<void> {
    this.requireRole('staff');
    await this.tenantDb.transaction((tx) => this.repo.replaceSponsor(tx, input));
  }

  private requireRole(who: 'staff' | 'team'): string {
    const { tenantId, role } = this.context.require();
    if (!tenantId) throw new InfoAreaRequiredException();
    const ok = isStaffRole(role) || (who === 'team' && role === 'agent');
    if (!ok) throw new InfoStaffOnlyException();
    return tenantId;
  }
}
