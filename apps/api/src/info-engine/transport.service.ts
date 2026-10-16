import { Injectable } from '@nestjs/common';
import { PostOwnershipService } from '../posts/post-ownership.service';
import type { InfoList, RouteDetail, RouteInput, RouteListQuery } from './dto/info-engine.dto';
import { routeCard } from './info-cards';
import { InfoItemNotFoundException, mapInfoEngineErrors } from './info-engine.exceptions';
import { InfoEngineRepository, type RouteDetailRow } from './info-engine.repository';
import { InfoScope } from './info-scope';

/**
 * Transport (ADR 065): routes near the viewer from every area (a stop, the
 * origin or the destination within the radius), each with its stops, its
 * timetable and the next departures from now in its area's own time. The
 * partner keeps them (staff and field agents); a save or a "still right"
 * check refreshes last_verified_at, and a route past info_stale_days_transport
 * says it may be out of date.
 */
@Injectable()
export class TransportService {
  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
    private readonly ownership: PostOwnershipService,
  ) {}

  async list(query: RouteListQuery): Promise<InfoList> {
    const tenantId = this.scope.tenantId();
    const [{ radiusKm, limit }, staleDays] = await Promise.all([
      this.scope.listing(tenantId),
      this.scope.settings.get('info_stale_days_transport', tenantId),
    ]);
    const now = new Date();
    const rows = await this.scope.read(async (tx) =>
      this.repo.routesNear(
        tx,
        await this.scope.origin(tx, tenantId, query),
        radiusKm,
        query.mode ?? null,
        limit,
      ),
    );
    return { items: rows.map((r) => routeCard(r, staleDays, now)), radiusKm, next: null };
  }

  async detail(id: string): Promise<RouteDetail> {
    this.scope.tenantId();
    const owner = await this.scope.asSystem((tx) => this.repo.routeTenant(tx, id));
    if (!owner) throw new InfoItemNotFoundException();
    const [staleDays, max] = await Promise.all([
      this.scope.settings.get('info_stale_days_transport', owner),
      this.scope.settings.get('transport_next_departures_max'),
    ]);
    const now = new Date();
    return this.ownership.inTenant(owner, 'lookup', () =>
      this.scope.read(async (tx) => {
        const row = await this.repo.route(tx, id);
        if (!row) throw new InfoItemNotFoundException();
        const [stops, schedules, next] = await Promise.all([
          this.repo.stops(tx, id),
          this.repo.schedules(tx, id),
          this.repo.nextDepartures(tx, id, now, max),
        ]);
        return toDetail(row, staleDays, now, stops, schedules, next);
      }),
    );
  }

  // ---- the area team ----------------------------------------------------------

  async teamList(): Promise<{ items: RouteDetail[] }> {
    const tenantId = this.scope.requireTeam();
    const staleDays = await this.scope.settings.get('info_stale_days_transport', tenantId);
    const now = new Date();
    return this.scope.read(async (tx) => {
      const routes = await this.repo.teamRoutes(tx);
      const items: RouteDetail[] = [];
      for (const r of routes) {
        items.push(
          toDetail(
            r,
            staleDays,
            now,
            await this.repo.stops(tx, r.id),
            await this.repo.schedules(tx, r.id),
            [],
          ),
        );
      }
      return { items };
    });
  }

  async save(id: string | null, input: RouteInput): Promise<{ id: string; status: string }> {
    this.scope.requireTeam();
    const saved = await mapInfoEngineErrors(() =>
      this.scope.write((tx) => this.repo.saveRoute(tx, id, input)),
    );
    if (!saved) throw new InfoItemNotFoundException();
    return { id: saved, status: 'active' };
  }

  async verify(id: string): Promise<void> {
    this.scope.requireTeam();
    if (!(await this.scope.write((tx) => this.repo.verifyRoute(tx, id))))
      throw new InfoItemNotFoundException();
  }

  async remove(id: string): Promise<void> {
    this.scope.requireTeam();
    if (!(await this.scope.write((tx) => this.repo.removeRoute(tx, id))))
      throw new InfoItemNotFoundException();
  }
}

function toDetail(
  row: RouteDetailRow,
  staleDays: number,
  now: Date,
  stops: Awaited<ReturnType<InfoEngineRepository['stops']>>,
  schedules: Awaited<ReturnType<InfoEngineRepository['schedules']>>,
  next: Awaited<ReturnType<InfoEngineRepository['nextDepartures']>>,
): RouteDetail {
  const pt = (lat: number | null, lng: number | null) =>
    lat !== null && lng !== null ? { lat, lng } : null;
  return {
    card: {
      ...routeCard(row, staleDays, now),
      badges: [row.mode_code, ...(row.is_active ? [] : ['inactive'])],
    },
    mode: row.mode_code,
    operatorName: row.operator_name,
    originName: row.origin_name,
    destinationName: row.destination_name,
    originLocation: pt(row.origin_lat, row.origin_lng),
    destinationLocation: pt(row.dest_lat, row.dest_lng),
    typicalDurationMinutes: row.typical_duration_minutes,
    fareMin: row.fare_min,
    fareMax: row.fare_max,
    fareUpdatedOn: row.fare_updated_on,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    contactPhones: row.contact_phones,
    notes: row.notes,
    stops: stops.map((s) => ({
      seq: s.seq,
      name: { bn: s.name_bn, en: s.name_en },
      location: pt(s.lat, s.lng),
      minutesFromOrigin: s.minutes_from_origin,
      fareFromOrigin: s.fare_from_origin,
    })),
    schedules: schedules.map((s) => ({
      id: s.id,
      direction: s.direction_code,
      departureTime: s.departure_time,
      days: s.iso_days_of_week,
      validFrom: s.valid_from,
      validTo: s.valid_to,
      serviceClass: s.service_class,
      fare: s.fare,
    })),
    nextDepartures: next.map((d) => ({
      departsAt: d.departs_at.toISOString(),
      direction: d.direction_code,
      serviceClass: d.service_class,
      fare: d.fare,
    })),
  };
}
