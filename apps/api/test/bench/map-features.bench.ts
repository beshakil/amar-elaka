/**
 * Benchmark for GET /api/v1/map/features (ADR 045): 5,000 public points in
 * one viewport, p95 must stay under 150 ms.
 *
 *   1. Seeds 3,000 live posts, 1,000 places, 500 stores and 500 emergency
 *      services into a Dhaka viewport (one fixture tenant, removed after).
 *   2. Calls the running API over HTTP, 1 and 10 at a time (BENCH_CONCURRENCY):
 *        cold  25 different tile-aligned boxes, the map cache flushed before
 *              each 25 -> the database path (map_features)
 *        warm  the same viewport again and again -> the Redis cache
 *      at zoom 12 (clustered) and zoom 16 (every point, capped).
 *   3. Prints p50/p95/p99 and fails (exit 1) if any p95 >= 150 ms.
 *
 * Usage (API running against the TEST database; BENCH_REDIS_URL = its Redis):
 *   BENCH_DATABASE_URL=postgresql://ae_dev:…@localhost:5433/amar_elaka_test \
 *   BENCH_API_URL=http://localhost:3100 pnpm --filter @amar-elaka/api bench:map
 */
import Redis from 'ioredis';
import postgres from 'postgres';

const DATABASE_URL = process.env.BENCH_DATABASE_URL;
const REDIS_URL = process.env.BENCH_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
const API_URL = (process.env.BENCH_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 300);
const CONCURRENCY_LEVELS = (process.env.BENCH_CONCURRENCY ?? '1,10').split(',').map(Number);
const TARGET_P95_MS = 150;
const REQUEST_TIMEOUT_MS = 10_000;

const FIXTURE = '0191e3a0-be4c-7000-8000-%';
const id = (n: number) => `0191e3a0-be4c-7000-8000-${String(n).padStart(12, '0')}`;
const PARTNER = id(1);
const AREA = id(2);
const TENANT = id(3);
const USER = id(4);
const MEMBER = id(5);
const CATEGORY = id(6);
const CATEGORY_PLACE = id(7);
const SCHEMA = id(8);

// The viewport of a 1280×800 screen at zoom 16 over Dhanmondi.
const VIEW = { minLng: 90.364, minLat: 23.743, maxLng: 90.392, maxLat: 23.764 };
const COUNTS = { posts: 3000, places: 1000, stores: 500, info: 500 };

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function cleanUp(sql: postgres.Sql): Promise<void> {
  // The seeded rows' search-index events (inserting and deleting both queue
  // them): left behind, thousands of them would delay every later test's.
  const ids = await sql<{ id: string }[]>`
    select id from posts where tenant_id::text like ${FIXTURE}
    union all select id from places where tenant_id::text like ${FIXTURE}
    union all select id from stores where tenant_id::text like ${FIXTURE}`;
  await sql`delete from emergency_contacts where tenant_id::text like ${FIXTURE}`;
  await sql`delete from posts where tenant_id::text like ${FIXTURE}`;
  await sql`delete from places where tenant_id::text like ${FIXTURE}`;
  await sql`delete from stores where tenant_id::text like ${FIXTURE}`;
  await sql`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
  await sql`delete from categories where id::text like ${FIXTURE}`;
  await sql`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
  await sql`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
  await sql`delete from tenants where id::text like ${FIXTURE}`;
  await sql`delete from partners where id::text like ${FIXTURE}`;
  await sql`delete from geo_areas where id::text like ${FIXTURE}`;
  await sql`delete from users where id::text like ${FIXTURE}`;
  await sql`delete from outbox_events where aggregate_id = any(${ids.map((r) => r.id)}::uuid[])`;
}

async function seed(sql: postgres.Sql): Promise<void> {
  await cleanUp(sql);
  await sql`insert into users (id, phone_e164) values (${USER}, '+8801799500001')`;
  await sql`insert into partners (id, legal_name, display_name, phone_e164)
            values (${PARTNER}, 'Bench', 'Bench', '+8801799500099')`;
  const area = `SRID=4326;MULTIPOLYGON(((${VIEW.minLng} ${VIEW.minLat},${VIEW.maxLng} ${VIEW.minLat},${VIEW.maxLng} ${VIEW.maxLat},${VIEW.minLng} ${VIEW.maxLat},${VIEW.minLng} ${VIEW.minLat})))`;
  await sql`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
            values (${AREA}, 3, 'upazila', 'bench', 'Bench Area', 'fixture', ${area}, ${area})`;
  await sql`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
            values (${TENANT}, ${PARTNER}, ${AREA}, 'bench', 'বেঞ্চ', 'Bench', 'SRID=4326;POINT(90.378 23.7535)', 'active')`;
  await sql`insert into tenant_settings (tenant_id) values (${TENANT})`;
  await sql`insert into tenant_members (id, tenant_id, user_id, role_code) values (${MEMBER}, ${TENANT}, ${USER}, 'member')`;
  await sql`insert into categories (id, kind_code, slug, name_bn, name_en) values
            (${CATEGORY}, 'marketplace', 'bench-phones', 'ফোন', 'Phones'),
            (${CATEGORY_PLACE}, 'place', 'bench-health', 'স্বাস্থ্য', 'Health')`;
  await sql`insert into category_field_schemas (id, category_id, version, json_schema, status_code)
            values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;
  const point = `st_setsrid(st_makepoint(${VIEW.minLng} + random() * ${VIEW.maxLng - VIEW.minLng}, ${VIEW.minLat} + random() * ${VIEW.maxLat - VIEW.minLat}), 4326)::geography`;
  await sql.unsafe(`
    insert into posts (tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
                       published_at, bumped_at, location, fields)
    select '${TENANT}', '${MEMBER}', '${CATEGORY}', '${SCHEMA}', 'বেঞ্চ পোস্ট ' || g, 'live', now(), now(),
           ${point}, '{"price": "1500.00"}'::jsonb
    from generate_series(1, ${COUNTS.posts}) g`);
  await sql.unsafe(`
    insert into places (tenant_id, category_id, slug, name_bn, name_en, location, source_code, status_code)
    select '${TENANT}', '${CATEGORY_PLACE}', 'bench-place-' || g, 'জায়গা ' || g, 'Place ' || g,
           ${point}, 'user_submitted', 'published'
    from generate_series(1, ${COUNTS.places}) g`);
  await sql.begin(async (tx) => {
    await tx`select set_config('app.role', 'tenant_admin', true)`;
    await tx.unsafe(`
      insert into stores (tenant_id, owner_member_id, slug, name_bn, name_en, location, status_code)
      select '${TENANT}', '${MEMBER}', 'bench-store-' || g, 'দোকান ' || g, 'Store ' || g, ${point}, 'active'
      from generate_series(1, ${COUNTS.stores}) g`);
  });
  await sql.unsafe(`
    insert into emergency_contacts (tenant_id, service_type_code, name_bn, name_en, phones, location, is_24h)
    select '${TENANT}', 'hospital', 'হাসপাতাল ' || g, 'Hospital ' || g, '{"+8801799500111"}', ${point}, true
    from generate_series(1, ${COUNTS.info}) g`);
  await sql`analyze posts`;
  await sql`analyze places`;
  await sql`analyze stores`;
  await sql`analyze emergency_contacts`;
}

/** Tiles at `zoom` are 360/2^zoom degrees of longitude wide. */
const tileDegrees = (zoom: number) => 360 / 2 ** zoom;

/**
 * The viewport moved by whole tiles on a 5×5 grid around the seeded area:
 * 25 different tile-aligned boxes per zoom (so 25 different cache keys),
 * each still covering most of the 5,000 points.
 */
function viewportUrl(zoom: number, step: number): string {
  const d = tileDegrees(zoom) * (zoom >= 16 ? 1 : 0.25);
  const dx = ((step % 5) - 2) * d;
  const dy = ((Math.floor(step / 5) % 5) - 2) * d * 0.9;
  const box = [VIEW.minLng + dx, VIEW.minLat + dy, VIEW.maxLng + dx, VIEW.maxLat + dy];
  return `${API_URL}/api/v1/map/features?bbox=${box.map((n) => n.toFixed(5)).join(',')}&zoom=${zoom}`;
}

async function flushMapCache(redis: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'map:features:*', 'COUNT', 1000);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}

interface Result {
  label: string;
  p95: number;
}

async function run(
  label: string,
  concurrency: number,
  urlFor: (i: number) => string,
  beforeBatch?: () => Promise<void>,
  batchSize = REQUESTS,
): Promise<Result> {
  const times: number[] = [];
  let features = 0;
  for (let start = 0; start < REQUESTS; start += batchSize) {
    await beforeBatch?.();
    let next = start;
    const end = Math.min(REQUESTS, start + batchSize);
    const worker = async () => {
      while (next < end) {
        const i = next++;
        const started = performance.now();
        const response = await fetch(urlFor(i), {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = (await response.json()) as { features?: unknown[] };
        times.push(performance.now() - started);
        if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
        features = Math.max(features, body.features?.length ?? 0);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
  times.sort((a, b) => a - b);
  const [p50, p95, p99] = [50, 95, 99].map((p) => percentile(times, p));
  const name = `${label} c=${concurrency}`;
  console.log(
    `${name.padEnd(32)} n=${times.length}  p50=${p50!.toFixed(1)}ms  p95=${p95!.toFixed(1)}ms  p99=${p99!.toFixed(1)}ms  features≤${features}`,
  );
  return { label: name, p95: p95! };
}

async function main(): Promise<void> {
  if (!DATABASE_URL)
    throw new Error('BENCH_DATABASE_URL is required (the TEST database, as a superuser)');
  const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    console.log(`seeding ${Object.values(COUNTS).reduce((a, b) => a + b)} points in one viewport…`);
    await seed(sql);
    // Warm-up: connections, prepared statements, the settings cache.
    await run('warm-up', 10, (i) => viewportUrl(14, i));
    const results: Result[] = [];
    for (const concurrency of CONCURRENCY_LEVELS) {
      for (const zoom of [12, 16]) {
        const kind = zoom < 16 ? 'clustered' : 'points';
        // Cold: 25 distinct boxes, the map cache flushed before each 25 —
        // every request is the database path.
        results.push(
          await run(
            `cold z${zoom} (${kind})`,
            concurrency,
            (i) => viewportUrl(zoom, i),
            () => flushMapCache(redis),
            25,
          ),
        );
        // Warm: the same viewport, from the Redis cache.
        results.push(
          await run(`warm z${zoom} (${kind}, cache)`, concurrency, () => viewportUrl(zoom, 12)),
        );
      }
    }
    const failing = results.filter((r) => r.p95 >= TARGET_P95_MS);
    if (failing.length > 0) {
      console.log(`FAIL: p95 >= ${TARGET_P95_MS} ms for ${failing.map((r) => r.label).join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log(`OK: every p95 < ${TARGET_P95_MS} ms`);
    }
  } finally {
    if (!process.env.BENCH_KEEP) await cleanUp(sql);
    await flushMapCache(redis).catch(() => undefined);
    redis.disconnect();
    await sql.end();
  }
}

void main();
