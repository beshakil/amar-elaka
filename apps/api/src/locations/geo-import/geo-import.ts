import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type TransactionSql } from 'postgres';
import { loadDotenv } from '../../config/load-dotenv';
import { REFERENCE_PATH, type ReferenceArea, type ReferenceFile } from './build-reference';

/**
 * `pnpm --filter @amar-elaka/api geo:import [--boundaries <dir|file>]`
 *
 * Loads the committed Bangladesh reference (infra/geo/reference/
 * bgd-admin-cod-ab-v03.json) into geo_areas, upserting BY PCODE level by
 * level so parents always exist first (ADR 003, ADR 026):
 *
 *   - names (English, Bengali), levels, parents, centres, release;
 *   - city corporations are imported with needs_manual_review (a tenant can't
 *     use them until verified — the 0004 trigger);
 *   - an area missing from the release is retired (is_active = false), never
 *     deleted: tenants and content reference it.
 *
 * `--boundaries` then loads polygons: either the COD-AB GeoJSON directory
 * (bgd_admin0..3.geojson, full precision — production) or one
 * FeatureCollection whose features carry `pcode` (the committed pilot
 * fixture). PostGIS parses the GeoJSON, repairs invalid rings, and derives
 * the simplified display boundary and a point-on-surface centre.
 *
 * Runs as ae_migrator (MIGRATION_DATABASE_URL) with app.role = system, like
 * db:seed: through RLS with a declared role, never around it. Post-import
 * checks fail the run (and roll everything back) if the data is inconsistent.
 */

// settings-exempt: import tooling — insert batch size, not a business rule
const BATCH = 1000;

/** ST_SimplifyPreserveTopology tolerance per ADM level, in degrees (ADR 003). */
// settings-exempt: display-geometry tuning from ADR 003's table, not a business rule
const SIMPLIFY_TOLERANCE: Record<number, number> = {
  0: 0.005,
  1: 0.005,
  2: 0.002,
  3: 0.0005,
  4: 0.0002,
};

// settings-exempt: import tooling — how far (m) a child's centre may sit outside its parent's boundary
const PARENT_CONTAINMENT_TOLERANCE_M = 500;

/** The committed, simplified boundaries of the pilot district (Mymensingh), for dev and tests. */
export const PILOT_BOUNDARIES_PATH = join(REFERENCE_PATH, '..', 'pilot-boundaries.geojson');

export function readReference(path = REFERENCE_PATH): ReferenceFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ReferenceFile;
}

/** Upserts every reference area by pcode; returns pcode → geo_areas.id. */
export async function importReference(
  tx: TransactionSql,
  reference: ReferenceFile,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const byLevel = new Map<number, ReferenceArea[]>();
  for (const area of reference.areas)
    byLevel.set(area.admLevel, [...(byLevel.get(area.admLevel) ?? []), area]);

  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    const areas = byLevel.get(level)!;
    for (let i = 0; i < areas.length; i += BATCH) {
      const rows: Record<string, unknown>[] = areas.slice(i, i + BATCH).map((a) => {
        const parentId = a.parentPcode === null ? null : ids.get(a.parentPcode);
        if (a.parentPcode !== null && parentId === undefined) {
          throw new Error(`${a.pcode}: parent ${a.parentPcode} not imported`);
        }
        return {
          cod_pcode: a.pcode,
          parent_id: parentId ?? null,
          adm_level: a.admLevel,
          level_code: a.levelCode,
          name_en: a.nameEn,
          name_bn: a.nameBn,
          centroid: `SRID=4326;POINT(${a.center[0]} ${a.center[1]})`,
          needs_manual_review: a.levelCode === 'city_corporation',
          source_release: reference.release,
        };
      });
      const inserted = await tx<{ id: string; cod_pcode: string }[]>`
        insert into geo_areas ${tx(
          rows,
          'cod_pcode',
          'parent_id',
          'adm_level',
          'level_code',
          'name_en',
          'name_bn',
          'centroid',
          'needs_manual_review',
          'source_release',
        )}
        on conflict (cod_pcode) where cod_pcode is not null do update set
          parent_id = excluded.parent_id,
          adm_level = excluded.adm_level,
          level_code = excluded.level_code,
          name_en = excluded.name_en,
          name_bn = coalesce(excluded.name_bn, geo_areas.name_bn),
          -- A boundary's point-on-surface beats the dataset's centre.
          centroid = case when geo_areas.boundary is null then excluded.centroid else geo_areas.centroid end,
          needs_manual_review = excluded.needs_manual_review,
          source_release = excluded.source_release,
          is_active = true
        returning id, cod_pcode`;
      for (const row of inserted) ids.set(row.cod_pcode, row.id);
    }
  }

  const pcodes = reference.areas.map((a) => a.pcode);
  await tx`
    update geo_areas set is_active = false
    where cod_pcode is not null and is_active and not (cod_pcode = any(${pcodes}))`;
  return ids;
}

interface BoundaryFeature {
  pcode: string;
  geometry: unknown;
}

/** COD-AB level files, or one FeatureCollection whose features have `pcode`. */
export function readBoundaries(path: string): BoundaryFeature[] {
  const files = statSync(path).isDirectory()
    ? [0, 1, 2, 3].map((l) => join(path, `bgd_admin${l}.geojson`)).filter((f) => existsSync(f))
    : [path];
  const features: BoundaryFeature[] = [];
  for (const file of files) {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      features: { properties: Record<string, unknown>; geometry: unknown }[];
    };
    for (const f of json.features) {
      const p = f.properties;
      const pcode = [p.pcode, p.adm3_pcode, p.adm2_pcode, p.adm1_pcode, p.adm0_pcode].find(
        (v): v is string => typeof v === 'string' && v !== '',
      );
      if (pcode !== undefined && f.geometry) features.push({ pcode, geometry: f.geometry });
    }
  }
  return features;
}

export async function importBoundaries(
  tx: TransactionSql,
  features: readonly BoundaryFeature[],
): Promise<number> {
  let updated = 0;
  for (const feature of features) {
    const result = await tx`
      with src as (
        select st_multi(st_collectionextract(st_makevalid(
                 st_setsrid(st_geomfromgeojson(${JSON.stringify(feature.geometry)}), 4326)), 3)) as geom
      )
      update geo_areas g set
        boundary = src.geom::geography,
        -- ::text::jsonb: with ::jsonb postgres-js would JSON-encode the string twice.
        boundary_simplified = st_multi(st_simplifypreservetopology(
          src.geom,
          (${JSON.stringify(SIMPLIFY_TOLERANCE)}::text::jsonb ->> g.adm_level::text)::float8
        ))::geography,
        centroid = st_pointonsurface(src.geom)::geography
      from src
      where g.cod_pcode = ${feature.pcode}`;
    updated += result.count;
  }
  return updated;
}

/**
 * ADM4 comes as points from an older release (2020) than the ADM3 polygons
 * (2023), and some upazilas were redrawn in between (Eidgaon, 2021). With
 * boundaries loaded, a union/pourashava point that lies outside its recorded
 * upazila but inside another ADM3 polygon is moved there: the newer
 * boundaries are authoritative. Returns the pcodes moved.
 */
export async function reparentPointsByContainment(tx: TransactionSql): Promise<string[]> {
  const moved = await tx<{ cod_pcode: string }[]>`
    update geo_areas c set parent_id = (
      select o.id from geo_areas o
      where o.adm_level = 3 and o.is_active and o.boundary is not null and st_covers(o.boundary, c.centroid)
      order by o.id limit 1
    )
    from geo_areas p
    where p.id = c.parent_id
      and c.adm_level = 4 and c.boundary is null and c.centroid is not null
      and p.boundary is not null
      and not st_dwithin(p.boundary, c.centroid, ${PARENT_CONTAINMENT_TOLERANCE_M})
      and exists (
        select 1 from geo_areas o
        where o.adm_level = 3 and o.is_active and o.boundary is not null and st_covers(o.boundary, c.centroid)
      )
    returning c.cod_pcode`;
  return moved.map((r) => r.cod_pcode);
}

export interface ImportCheck {
  /** Fail the import. */
  problems: string[];
  /** Reported, not fatal. */
  warnings: string[];
}

/** ADR 003 post-import checks. */
export async function checkImport(
  tx: TransactionSql,
  reference: ReferenceFile,
): Promise<ImportCheck> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const expected = new Map<string, number>();
  for (const a of reference.areas) expected.set(a.levelCode, (expected.get(a.levelCode) ?? 0) + 1);
  const counts = await tx<{ level_code: string; n: number }[]>`
    select level_code, count(*)::int as n from geo_areas
    where cod_pcode is not null and is_active group by level_code`;
  for (const [level, n] of expected) {
    const actual = counts.find((c) => c.level_code === level)?.n ?? 0;
    if (actual !== n) problems.push(`${level}: ${actual} active rows, reference has ${n}`);
  }
  const [orphans] = await tx<{ n: number }[]>`
    select count(*)::int as n from geo_areas where cod_pcode is not null and adm_level > 0 and parent_id is null`;
  if (orphans!.n > 0) problems.push(`${orphans!.n} areas without a parent`);
  const [invalid] = await tx<{ n: number }[]>`
    select count(*)::int as n from geo_areas where boundary is not null and not st_isvalid(boundary::geometry)`;
  if (invalid!.n > 0) problems.push(`${invalid!.n} invalid boundaries`);
  const [unsimplified] = await tx<{ n: number }[]>`
    select count(*)::int as n from geo_areas where boundary is not null and boundary_simplified is null`;
  if (unsimplified!.n > 0)
    problems.push(`${unsimplified!.n} boundaries without a display (simplified) shape`);
  const outside = await tx<{ cod_pcode: string; points_only: boolean }[]>`
    select c.cod_pcode, c.boundary is null as points_only
    from geo_areas c join geo_areas p on p.id = c.parent_id
    where c.cod_pcode is not null and c.centroid is not null and p.boundary is not null
      and not st_dwithin(p.boundary, c.centroid, ${PARENT_CONTAINMENT_TOLERANCE_M})`;
  const polygonsOutside = outside.filter((r) => !r.points_only).map((r) => r.cod_pcode);
  const pointsOutside = outside.filter((r) => r.points_only).map((r) => r.cod_pcode);
  if (polygonsOutside.length > 0) {
    problems.push(`areas outside their parent: ${polygonsOutside.join(', ')}`);
  }
  if (pointsOutside.length > 0) {
    warnings.push(
      `points outside every upazila (kept under their recorded parent): ${pointsOutside.join(', ')}`,
    );
  }
  const retired = await tx<{ slug: string }[]>`
    select t.slug from tenants t join geo_areas g on g.id = t.geo_area_id
    where not g.is_active and t.status_code <> 'archived'`;
  if (retired.length > 0) {
    problems.push(
      `live tenants on retired areas (handle by hand): ${retired.map((r) => r.slug).join(', ')}`,
    );
  }
  return { problems, warnings };
}

/** Run as the system role inside one transaction; any failed check rolls it all back. */
export async function runGeoImport(
  url: string,
  options: { boundaries?: string | undefined; reference?: string | undefined } = {},
): Promise<{ areas: number; boundaries: number; reparented: string[]; warnings: string[] }> {
  const reference = readReference(options.reference);
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`select set_config('app.is_platform_admin', 'true', true)`;
      const ids = await importReference(tx, reference);
      const boundaries = options.boundaries
        ? await importBoundaries(tx, readBoundaries(options.boundaries))
        : 0;
      // Every run, not only with --boundaries: the reference upsert restores the
      // recorded parents, and the ADM3 polygons may already be in the database.
      const reparented = await reparentPointsByContainment(tx);
      const { problems, warnings } = await checkImport(tx, reference);
      if (problems.length > 0)
        throw new Error(`geo import checks failed:\n  - ${problems.join('\n  - ')}`);
      return { areas: ids.size, boundaries, reparented, warnings };
    });
  } finally {
    await sql.end();
  }
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (require.main === module) {
  loadDotenv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL to run the geo import.');
  runGeoImport(url, { boundaries: option('--boundaries'), reference: option('--reference') }).then(
    ({ areas, boundaries, reparented, warnings }) => {
      console.log(`geo_areas: ${areas} areas upserted, ${boundaries} boundaries loaded`);
      if (reparented.length > 0) {
        console.log(
          `moved ${reparented.length} union/pourashava points to the upazila that contains them: ${reparented.join(', ')}`,
        );
      }
      for (const warning of warnings) console.warn(`warning: ${warning}`);
      process.exit(0);
    },
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
