import { Injectable } from '@nestjs/common';
import type { InfoServices, PrayerSettings } from './dto/info-engine.dto';
import { InfoEngineRepository } from './info-engine.repository';
import { InfoScope } from './info-scope';

/**
 * Prayer times are calculated on the device from its coordinates (ADR 065;
 * no API is called for them). The area only says how: the method, the Asr
 * school, the Hijri adjustment (local moon sighting) and the sehri / iftar
 * caution minutes — all tenant settings.
 */
@Injectable()
export class PrayerService {
  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
  ) {}

  async settings(): Promise<PrayerSettings> {
    const tenantId = this.scope.tenantId();
    const s = this.scope.settings;
    const [method, asrSchool, hijriAdjustDays, sehriCautionMinutes, iftarCautionMinutes] =
      await Promise.all([
        s.get('prayer_calc_method', tenantId),
        s.get('prayer_asr_school', tenantId),
        s.get('prayer_hijri_adjust_days', tenantId),
        s.get('prayer_sehri_caution_minutes', tenantId),
        s.get('prayer_iftar_caution_minutes', tenantId),
      ]);
    const { center, timezone } = await this.scope.read(async (tx) => ({
      center: (await this.repo.tenantCenter(tx, tenantId)) ?? null,
      timezone: await this.repo.tenantTimezone(tx, tenantId),
    }));
    return {
      method,
      asrSchool,
      hijriAdjustDays,
      sehriCautionMinutes,
      iftarCautionMinutes,
      center,
      timezone,
    };
  }

  /** Which services the area offers (agriculture: rural areas, agri_services_enabled). */
  async services(): Promise<InfoServices> {
    const tenantId = this.scope.tenantId();
    return { agri: await this.scope.settings.get('agri_services_enabled', tenantId) };
  }
}
