import { Injectable } from '@nestjs/common';
import type {
  InfoList,
  OriginOnly,
  OutageAdminList,
  OutageInput,
  OutageReportInput,
  OutageReportResult,
} from './dto/info-engine.dto';
import { clusterCard, outageCard } from './info-cards';
import { InfoItemNotFoundException, mapInfoEngineErrors } from './info-engine.exceptions';
import { InfoEngineRepository } from './info-engine.repository';
import { InfoScope } from './info-scope';

/**
 * Load-shedding and utility outages (ADR 065): the partner's scheduled
 * outages (ongoing, and upcoming within outage_upcoming_hours), and what
 * members report — an area shows "reported" only once
 * outage_report_min_reports different people agree within the window. Both
 * near the viewer, from every area; the expiry job ends them.
 */
@Injectable()
export class OutagesService {
  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
  ) {}

  async list(query: OriginOnly): Promise<InfoList> {
    const tenantId = this.scope.tenantId();
    const { radiusKm, limit } = await this.scope.listing(tenantId);
    const now = new Date();
    const { scheduled, reported } = await this.scope.read(async (tx) => {
      const origin = await this.scope.origin(tx, tenantId, query);
      return {
        scheduled: await this.repo.outagesNear(tx, origin, radiusKm, limit),
        reported: await this.repo.outageClusters(tx, origin, radiusKm),
      };
    });
    // Happening now first: reports (live by definition), then scheduled ones by start.
    return {
      items: [...reported.map(clusterCard), ...scheduled.map((r) => outageCard(r, now))].slice(
        0,
        limit,
      ),
      radiusKm,
      next: null,
    };
  }

  /** "No power / gas / water here now" (signed in). */
  async report(input: OutageReportInput): Promise<OutageReportResult> {
    const tenantId = this.scope.tenantId();
    const threshold = await this.scope.settings.get('outage_report_min_reports', tenantId);
    const result = await mapInfoEngineErrors(() =>
      this.scope.write((tx) => this.repo.reportOutage(tx, input.utility, input.location ?? null)),
    );
    return { reporters: result.reporters, threshold, shown: result.reporters >= threshold };
  }

  // ---- the area team ----------------------------------------------------------

  async teamList(): Promise<OutageAdminList> {
    this.scope.requireTeam();
    const [rows, localities] = await this.scope.read(async (tx) => [
      await this.repo.teamOutages(tx),
      await this.repo.localities(tx),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        utility: r.utility_code,
        localityId: r.locality_id,
        areaText: r.area_text,
        startsAt: r.starts_at.toISOString(),
        endsAt: r.ends_at.toISOString(),
        reason: r.reason_text,
        status: r.status_code,
      })),
      localities: localities.map((l) => ({ id: l.id, name: { bn: l.name_bn, en: l.name_en } })),
    };
  }

  async create(input: OutageInput): Promise<{ id: string; status: string }> {
    this.scope.requireTeam();
    const id = await mapInfoEngineErrors(() =>
      this.scope.write((tx) => this.repo.insertOutage(tx, input)),
    );
    return { id, status: 'scheduled' };
  }

  async update(id: string, input: OutageInput): Promise<void> {
    this.scope.requireTeam();
    const found = await mapInfoEngineErrors(() =>
      this.scope.write((tx) => this.repo.updateOutage(tx, id, input)),
    );
    if (!found) throw new InfoItemNotFoundException();
  }

  async cancel(id: string): Promise<void> {
    this.scope.requireTeam();
    const found = await this.scope.write((tx) => this.repo.cancelOutage(tx, id));
    if (!found) throw new InfoItemNotFoundException();
  }
}
