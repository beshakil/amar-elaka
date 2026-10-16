import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { isStaffRole } from '../posts/post-visibility';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import type {
  EmergencyAdminList,
  EmergencyContact,
  EmergencyContactInput,
  EmergencyPage,
  OriginQuery,
} from './dto/info.dto';
import {
  EmergencyContactNotFoundException,
  InfoAreaRequiredException,
  InfoStaffOnlyException,
} from './info.exceptions';
import { InfoRepository, type EmergencyRow } from './info.repository';

// settings-exempt: unit conversion (the interval itself is emergency_refresh_hours)
const SECONDS_PER_HOUR = 3600;
// settings-exempt: hex digits of the content hash kept as the version tag
const VERSION_HEX_LENGTH = 16;

/**
 * The emergency page (ADR 064): national hotlines (global) and local
 * contacts near the viewer from every area (rule 10), grouped by service
 * type. The one screen that must never fail: the apps keep an offline copy
 * keyed by `version` and refresh it every emergency_refresh_hours.
 */
@Injectable()
export class EmergencyService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: InfoRepository,
    private readonly settings: SettingsService,
  ) {}

  async page(query: OriginQuery): Promise<EmergencyPage> {
    const tenantId = this.requireTenant();
    const [radiusKm, limit, refreshHours] = await Promise.all([
      this.settings.get('emergency_contacts_radius_km', tenantId),
      this.settings.get('emergency_contacts_max'),
      this.settings.get('emergency_refresh_hours'),
    ]);
    const { hotlines, contacts, order } = await this.tenantDb.transaction(
      async (tx) => {
        const origin =
          query.lat !== undefined && query.lng !== undefined
            ? { lat: query.lat, lng: query.lng }
            : await this.repo.tenantCenter(tx, tenantId);
        const [h, c, o] = await Promise.all([
          this.repo.hotlines(tx),
          origin ? this.repo.emergencyNear(tx, origin, radiusKm, tenantId, limit) : [],
          this.repo.serviceTypeOrder(tx),
        ]);
        return { hotlines: h, contacts: c, order: o };
      },
      { accessMode: 'read only' },
    );

    const national = hotlines.map((h) => ({
      id: h.id,
      serviceType: h.service_type_code,
      name: { bn: h.name_bn, en: h.name_en },
      description: { bn: h.description_bn, en: h.description_en },
      dial: h.dial_string,
    }));
    const byType = new Map<string, EmergencyContact[]>();
    for (const row of contacts) {
      const list = byType.get(row.service_type_code) ?? [];
      list.push(toContact(row));
      byType.set(row.service_type_code, list);
    }
    const groups = order
      .filter((code) => byType.has(code))
      .map((code) => ({ serviceType: code, contacts: byType.get(code)! }));
    const content = { radiusKm, national, groups };
    return {
      // The content alone (no timestamps): unchanged data keeps the apps' copy.
      version: createHash('sha256')
        .update(JSON.stringify(content))
        .digest('hex')
        .slice(0, VERSION_HEX_LENGTH),
      generatedAt: new Date().toISOString(),
      refreshAfterSeconds: refreshHours * SECONDS_PER_HOUR,
      ...content,
    };
  }

  // ---- the area team: staff and field agents -----------------------------

  async adminList(): Promise<EmergencyAdminList> {
    this.requireTeam();
    const rows = await this.tenantDb.transaction((tx) => this.repo.emergencyAdminList(tx), {
      accessMode: 'read only',
    });
    return {
      items: rows.map((r) => ({ ...toContact(r), isActive: r.is_active, sortOrder: r.sort_order })),
    };
  }

  async create(input: EmergencyContactInput): Promise<{ id: string }> {
    this.requireTeam();
    const id = await this.tenantDb.transaction((tx) => this.repo.insertEmergency(tx, input));
    return { id };
  }

  async update(id: string, input: EmergencyContactInput): Promise<void> {
    this.requireTeam();
    const found = await this.tenantDb.transaction((tx) => this.repo.updateEmergency(tx, id, input));
    if (!found) throw new EmergencyContactNotFoundException();
  }

  async verify(id: string): Promise<void> {
    this.requireTeam();
    const found = await this.tenantDb.transaction((tx) => this.repo.verifyEmergency(tx, id));
    if (!found) throw new EmergencyContactNotFoundException();
  }

  async remove(id: string): Promise<void> {
    this.requireTeam();
    const found = await this.tenantDb.transaction((tx) => this.repo.deleteEmergency(tx, id));
    if (!found) throw new EmergencyContactNotFoundException();
  }

  private requireTenant(): string {
    const tenantId = this.context.require().tenantId;
    if (!tenantId) throw new InfoAreaRequiredException();
    return tenantId;
  }

  /** Staff or a field agent of the request's area (RLS enforces the same). */
  private requireTeam(): void {
    this.requireTenant();
    const role = this.context.require().role;
    if (!isStaffRole(role) && role !== 'agent') throw new InfoStaffOnlyException();
  }
}

function toContact(row: EmergencyRow): EmergencyContact {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    serviceType: row.service_type_code,
    name: { bn: row.name_bn, en: row.name_en },
    phones: row.phones,
    address: row.address_text,
    location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
    is24h: row.is_24h,
    availabilityNote: row.availability_note,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    distanceMeters: row.distance_m === null ? null : Math.round(row.distance_m),
  };
}
