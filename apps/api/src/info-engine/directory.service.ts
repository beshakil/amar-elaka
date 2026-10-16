import { Injectable } from '@nestjs/common';
import type { DirectoryQuery, InfoList } from './dto/info-engine.dto';
import { directoryCard } from './info-cards';
import { InfoEngineRepository } from './info-engine.repository';
import { decodeCursor, DIRECTORY, encodeCursor } from './info-engine.rules';
import { InfoScope } from './info-scope';

/**
 * Directories (ADR 065): hospitals, clinics and diagnostic centres,
 * pharmacies (with the 24-hour flag), schools, colleges and madrasas. They
 * are places — the places module keeps them, the map shows them (map_kinds)
 * — listed here by kind near the viewer from every area, with open-now
 * (is_open_at, the one rule) and the stale flag (info_stale_days_directory).
 */
@Injectable()
export class DirectoryService {
  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
  ) {}

  async list(query: DirectoryQuery): Promise<InfoList> {
    const tenantId = this.scope.tenantId();
    const [{ radiusKm, limit }, staleDays] = await Promise.all([
      this.scope.listing(tenantId),
      this.scope.settings.get('info_stale_days_directory', tenantId),
    ]);
    const kind = DIRECTORY[query.kind];
    const now = new Date();
    const { rows, open } = await this.scope.read(async (tx) => {
      const found = await this.repo.directoryNear(tx, {
        origin: await this.scope.origin(tx, tenantId, query),
        radiusKm,
        categories: kind.categories,
        fieldKey: kind.fieldKey,
        fieldValues: query.sub ? query.sub.split(',') : null,
        only24h: query.open24,
        after: query.after ? decodeCursor(query.after) : null,
        limit,
      });
      return {
        rows: found,
        open: await this.repo.openStates(
          tx,
          found.map((r) => r.id),
        ),
      };
    });
    const last = rows.at(-1);
    return {
      items: rows.map((r) => directoryCard(r, staleDays, now, open.get(r.id))),
      radiusKm,
      next: last && rows.length >= limit ? encodeCursor(last.distance_m, last.id) : null,
    };
  }
}
