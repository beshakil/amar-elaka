import { Injectable } from '@nestjs/common';
import type {
  GovServiceDetail,
  GovServiceInput,
  GovVersion,
  InfoList,
  Published,
} from './dto/info-engine.dto';
import { govCard } from './info-cards';
import { InfoItemNotFoundException, mapInfoEngineErrors } from './info-engine.exceptions';
import { InfoEngineRepository, type GovRow, type GovVersionRow } from './info-engine.repository';
import { InfoScope } from './info-scope';

/**
 * The government service guide (ADR 065): structured entries — the
 * service, its office (on the map, optionally a place), hours, the documents
 * to bring, fees, steps, official links — kept by the partner. Every save is
 * a new immutable version (gov_service_publish); "last verified on" shows
 * on every entry and past info_stale_days_gov_service it says so.
 *
 * Unlike the other lists this is the area's own board, not a radius: which
 * office serves you is decided by the boundary (ownership, rule 10).
 */
@Injectable()
export class GovServicesService {
  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
  ) {}

  async list(category: string | null): Promise<InfoList> {
    const tenantId = this.scope.tenantId();
    const staleDays = await this.scope.settings.get('info_stale_days_gov_service', tenantId);
    const now = new Date();
    const rows = await this.scope.read((tx) => this.repo.govServices(tx, category, false));
    return { items: rows.map((r) => govCard(r, staleDays, now)), radiusKm: null, next: null };
  }

  async detail(slug: string): Promise<GovServiceDetail> {
    const tenantId = this.scope.tenantId();
    const staleDays = await this.scope.settings.get('info_stale_days_gov_service', tenantId);
    return this.scope.read(async (tx) => {
      const row = await this.repo.govService(tx, slug);
      if (!row) throw new InfoItemNotFoundException();
      const versions = await this.repo.govVersions(tx, row.id);
      return {
        card: govCard(row, staleDays, new Date()),
        id: row.id,
        slug: row.slug,
        category: row.category_code,
        lastVerifiedOn: row.last_verified_on,
        current: toVersion(row),
        versions: versions.map((v) => ({
          versionNo: v.version_no,
          createdAt: v.created_at.toISOString(),
          changeNote: v.change_note,
        })),
      };
    });
  }

  async version(slug: string, no: number): Promise<GovVersion> {
    this.scope.tenantId();
    return this.scope.read(async (tx) => {
      const row = await this.repo.govService(tx, slug);
      if (!row) throw new InfoItemNotFoundException();
      const v = await this.repo.govVersion(tx, row.id, no);
      if (!v) throw new InfoItemNotFoundException();
      return toVersion(v);
    });
  }

  // ---- the area team ----------------------------------------------------------

  async teamList(): Promise<InfoList> {
    const tenantId = this.scope.requireTeam();
    const staleDays = await this.scope.settings.get('info_stale_days_gov_service', tenantId);
    const rows = await this.scope.read((tx) => this.repo.govServices(tx, null, true));
    return {
      items: rows.map((r) => govCard(r, staleDays, new Date())),
      radiusKm: null,
      next: null,
    };
  }

  /** A new entry (id null) or a new version of one. */
  async publish(id: string | null, input: GovServiceInput): Promise<Published> {
    this.scope.requireTeam();
    const result = await mapInfoEngineErrors(() =>
      this.scope.write((tx) => this.repo.govPublish(tx, id, input)),
    );
    return { id: result.service_id, versionNo: result.version_no };
  }

  async verify(id: string): Promise<void> {
    this.scope.requireTeam();
    await mapInfoEngineErrors(() => this.scope.write((tx) => this.repo.govVerify(tx, id)));
  }

  async setActive(id: string, active: boolean): Promise<void> {
    this.scope.requireTeam();
    if (!(await this.scope.write((tx) => this.repo.govSetActive(tx, id, active)))) {
      throw new InfoItemNotFoundException();
    }
  }
}

function toVersion(v: GovRow | GovVersionRow): GovVersion {
  return {
    versionNo: v.version_no,
    name: { bn: v.name_bn, en: v.name_en },
    summary: v.summary_bn,
    officeName: v.office_name,
    officePlaceId: v.office_place_id,
    address: v.address_text,
    location: v.lat !== null && v.lng !== null ? { lat: v.lat, lng: v.lng } : null,
    hours: v.hours_text,
    documents: v.documents,
    fees: v.fees,
    steps: v.steps,
    links: v.links,
    changeNote: v.change_note,
    createdAt: v.version_created_at.toISOString(),
  };
}
