import { Injectable } from '@nestjs/common';
import type { InfoCard } from './dto/info-engine.dto';
import { clusterCard, lostFoundCard, noticeCard, outageCard } from './info-cards';
import { InfoEngineRepository, type Origin } from './info-engine.repository';
import { InfoMedia } from './info-media';
import { InfoScope } from './info-scope';

/**
 * The feed's local information cards (ADR 065): what matters now near the
 * viewer, most urgent first — an outage happening (reported or scheduled),
 * a pinned or official notice, a janaza notice, a lost & found report —
 * at most feed_info_cards_max. Public data only, so the shared first-page
 * cache may hold it.
 */
@Injectable()
export class InfoFeedService {
  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
    private readonly media: InfoMedia,
  ) {}

  async cards(tenantId: string, origin: Origin, max: number): Promise<InfoCard[]> {
    const radiusKm = await this.scope.settings.get('info_search_radius_km', tenantId);
    // Fetch twice the cap of notices: only pinned, official and janaza ones qualify.
    const noticeWindow = max + max;
    const now = new Date();
    const { reported, scheduled, notices, lost } = await this.scope.read(async (tx) => ({
      reported: await this.repo.outageClusters(tx, origin, radiusKm),
      scheduled: await this.repo.outagesNear(tx, origin, radiusKm, max),
      notices: await this.repo.noticesNear(tx, origin, radiusKm, null, noticeWindow),
      lost: await this.repo.lostFoundNear(tx, {
        origin,
        radiusKm,
        kind: null,
        itemType: null,
        limit: max,
      }),
    }));
    const ongoing = scheduled.filter((o) => o.starts_at <= now);
    const important = notices.filter(
      (n) => n.is_pinned || n.is_official || n.notice_type_code === 'obituary',
    );
    const candidates: InfoCard[] = [
      ...reported.map(clusterCard),
      ...ongoing.map((o) => outageCard(o, now)),
      ...important.map(noticeCard),
      ...lost.map((l) =>
        lostFoundCard(l, this.media.cardImage(l.photo_variants, l.photo_thumbhash)),
      ),
    ];
    // One card per type first, so a busy type doesn't push the others out.
    const seen = new Set<string>();
    const firstOfEach = candidates.filter((c) => (seen.has(c.type) ? false : seen.add(c.type)));
    const rest = candidates.filter((c) => !firstOfEach.includes(c));
    return [...firstOfEach, ...rest].slice(0, max);
  }
}
