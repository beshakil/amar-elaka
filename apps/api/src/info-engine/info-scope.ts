import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { isStaffRole } from '../posts/post-visibility';
import { SettingsService } from '../settings/settings.service';
import { InfoEngineAreaRequiredException, InfoTeamOnlyException } from './info-engine.exceptions';
import { InfoEngineRepository, type Origin } from './info-engine.repository';

/**
 * What every info engine service needs (ADR 065): the request's area, who
 * the caller is there (staff, field agent), the viewer's point (else the
 * area's centre), the list radius and page size, and transactions.
 */
@Injectable()
export class InfoScope {
  constructor(
    readonly tenantDb: TenantDb,
    readonly context: TenantContext,
    readonly settings: SettingsService,
    private readonly repo: InfoEngineRepository,
  ) {}

  tenantId(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new InfoEngineAreaRequiredException();
    return tenantId;
  }

  isStaff(): boolean {
    return isStaffRole(this.context.require().role);
  }

  /** Staff or a field agent: the people who keep the area's information. */
  isTeam(): boolean {
    return this.isStaff() || this.context.require().role === 'agent';
  }

  requireTeam(): string {
    const tenantId = this.tenantId();
    if (!this.isTeam()) throw new InfoTeamOnlyException();
    return tenantId;
  }

  requireStaff(): string {
    const tenantId = this.tenantId();
    if (!this.isStaff()) throw new InfoTeamOnlyException();
    return tenantId;
  }

  async origin(
    tx: DatabaseTransaction,
    tenantId: string,
    q: { lat?: number | undefined; lng?: number | undefined },
  ): Promise<Origin> {
    if (q.lat !== undefined && q.lng !== undefined) return { lat: q.lat, lng: q.lng };
    const center = await this.repo.tenantCenter(tx, tenantId);
    if (!center) throw new InfoEngineAreaRequiredException();
    return center;
  }

  async listing(tenantId: string): Promise<{ radiusKm: number; limit: number }> {
    const [radiusKm, limit] = await Promise.all([
      this.settings.get('info_search_radius_km', tenantId),
      this.settings.get('info_page_size_max'),
    ]);
    return { radiusKm, limit };
  }

  read<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }

  write<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work);
  }

  /** Reads private rows (document attachments, owners' areas) as the system. */
  asSystem<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.context.run({ role: 'system' }, () => this.read(work));
  }
}
