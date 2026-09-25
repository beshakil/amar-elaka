import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One-off, re-runnable: builds the committed geo reference file from the two
 * open datasets (ADR 003, ADR 026):
 *
 *   --cod <dir>    HDX "Bangladesh - Subnational Administrative Boundaries"
 *                  (COD-AB, BBS via OCHA, CC BY-IGO), the GeoJSON release:
 *                  bgd_admin0..3.geojson (polygons) and bgd_adminpoints.geojson
 *                  (ADM4 union points).
 *   --names <dir>  nuhil/bangladesh-geocode (MIT): divisions, districts,
 *                  upazilas, unions JSON with Bengali names.
 *
 * Output (both committed):
 *   infra/geo/reference/bgd-admin-cod-ab-v03.json  every area, keyed by pcode
 *   infra/geo/reference/name-bn-report.md          Bengali names to review
 *
 * Runtime joins are by pcode only. The Bengali-name dataset has no pcodes, so
 * its names are matched to pcodes HERE, once, within the same parent, and the
 * result is reviewed through the report. Division names are fixed below by
 * pcode; district names come from the dataset through an explicit alias list.
 *
 *   pnpm --filter @amar-elaka/api exec tsx src/locations/geo-import/build-reference.ts \
 *     --cod <dir> --names <dir>
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
export const REFERENCE_PATH = join(
  REPO_ROOT,
  'infra',
  'geo',
  'reference',
  'bgd-admin-cod-ab-v03.json',
);
const REPORT_PATH = join(REPO_ROOT, 'infra', 'geo', 'reference', 'name-bn-report.md');

/** Hand-checked by pcode (COD-AB ADM1). */
const DIVISION_NAMES_BN: Record<string, string> = {
  BD10: 'বরিশাল',
  BD20: 'চট্টগ্রাম',
  BD30: 'ঢাকা',
  BD40: 'খুলনা',
  BD45: 'ময়মনসিংহ',
  BD50: 'রাজশাহী',
  BD55: 'রংপুর',
  BD60: 'সিলেট',
};

/** COD-AB district spelling → name dataset spelling, where they differ. */
const DISTRICT_ALIASES: Record<string, string> = {
  Barishal: 'Barisal',
  Jhalokati: 'Jhalakathi',
  Cumilla: 'Comilla',
  Netrakona: 'Netrokona',
  Chapainababganj: 'Chapainawabganj',
  "Cox's Bazar": 'Coxsbazar',
};

/**
 * Upazilas the name dataset doesn't have (created or renamed after it), or
 * spells too differently to match safely. Hand-checked, by pcode.
 */
const UPAZILA_NAMES_BN: Record<string, string> = {
  BD20130076: 'মতলব দক্ষিণ',
  BD20130079: 'মতলব উত্তর',
  BD20220032: 'ঈদগাঁও',
  BD20190067: 'আদর্শ সদর',
  BD20190033: 'সদর দক্ষিণ',
  BD40470017: 'দাকোপ',
  BD10060051: 'বরিশাল সদর',
  BD10790090: 'ইন্দুরকানী',
  BD10790087: 'নেছারাবাদ',
  BD60360087: 'শায়েস্তাগঞ্জ',
  BD60900087: 'শান্তিগঞ্জ',
};

/** City corporations are not in the name dataset. */
const CITY_CORPORATION_NAMES_BN: Record<string, string> = {
  BD20151600: 'চট্টগ্রাম সিটি কর্পোরেশন',
  BD20195000: 'কুমিল্লা সিটি কর্পোরেশন',
  BD30262500: 'ঢাকা উত্তর সিটি কর্পোরেশন',
  BD30262000: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন',
  BD30333300: 'গাজীপুর সিটি কর্পোরেশন',
  BD30674400: 'নারায়ণগঞ্জ সিটি কর্পোরেশন',
  BD40473300: 'খুলনা সিটি কর্পোরেশন',
  BD50816600: 'রাজশাহী সিটি কর্পোরেশন',
  BD10065000: 'বরিশাল সিটি কর্পোরেশন',
  BD45614000: 'ময়মনসিংহ সিটি কর্পোরেশন',
  BD55857500: 'রংপুর সিটি কর্পোরেশন',
  BD60915000: 'সিলেট সিটি কর্পোরেশন',
};

export type LevelCode =
  'country' | 'division' | 'district' | 'upazila' | 'city_corporation' | 'union' | 'pourashava';

export interface ReferenceArea {
  pcode: string;
  parentPcode: string | null;
  admLevel: 0 | 1 | 2 | 3 | 4;
  levelCode: LevelCode;
  nameEn: string;
  nameBn: string | null;
  /** [lng, lat] from the dataset (polygon centre, or the union's point). */
  center: [number, number];
}

export interface ReferenceFile {
  source: string;
  licence: string;
  attribution: string;
  release: string;
  namesSource: string;
  areas: ReferenceArea[];
}

interface Feature {
  properties: Record<string, unknown>;
}
interface NameRow {
  id: string;
  name: string;
  bn_name: string;
  division_id?: string;
  district_id?: string;
  upazilla_id?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * A spelling-insensitive key for English place names: case, spaces and
 * punctuation dropped, ph→f, w→o, h dropped after a consonant (bh/kh/chh…),
 * doubled letters and vowel runs collapsed ("Muktagachha" = "Muktagacha",
 * "Phulpur" = "Fulpur", "Ishwarganj" = "Iswarganj").
 */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/w/g, 'o')
    .replace(/([bcdgjkpstz])h+/g, '$1')
    .replace(/(.)\1+/g, '$1')
    .replace(/[aeiouy]+/g, 'a');
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

type Match = { row: NameRow; how: 'exact' | 'key' | 'fuzzy' } | undefined;

/** Best match among one parent's children: exact name, then key, then a unique near key. */
export function matchName(name: string, candidates: readonly NameRow[]): Match {
  const exact = candidates.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (exact) return { row: exact, how: 'exact' };
  const key = nameKey(name);
  const byKey = candidates.filter((c) => nameKey(c.name) === key);
  if (byKey.length === 1) return { row: byKey[0]!, how: 'key' };
  const scored = candidates
    .map((c) => ({ c, d: editDistance(nameKey(c.name), key) }))
    .sort((x, y) => x.d - y.d);
  const best = scored[0];
  const limit = Math.max(1, Math.floor(key.length / 4));
  if (best && best.d <= limit && scored[1]?.d !== best.d) return { row: best.c, how: 'fuzzy' };
  return undefined;
}

function readFeatures(dir: string, file: string): Feature[] {
  return (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { features: Feature[] }).features;
}

function readNames(dir: string, file: string): NameRow[] {
  const json = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
  if (Array.isArray(json)) {
    const table = json.find(
      (x): x is { type: string; data: NameRow[] } =>
        typeof x === 'object' && x !== null && (x as { type?: string }).type === 'table',
    );
    return table?.data ?? (json as NameRow[]);
  }
  return json as NameRow[];
}

const POURASHAVA = /^(.+?)\s+P(?:au|ou|o|a)rashava$/i;

/** Points use the 2020 ADM3 code (BD404480); polygons the 2023 one (BD40440080). */
export function upazilaPcodeFromPointCode(code: string): string {
  return `${code.slice(0, 6)}00${code.slice(6)}`;
}

export function buildReference(
  codDir: string,
  namesDir: string,
): { file: ReferenceFile; report: string } {
  const report: string[] = [];
  const reviewed: string[] = [];
  const areas: ReferenceArea[] = [];

  const [country] = readFeatures(codDir, 'bgd_admin0.geojson');
  const release = `COD-AB ${str(country!.properties.version)} valid_on ${str(country!.properties.valid_on)}`;
  areas.push({
    pcode: str(country!.properties.adm0_pcode),
    parentPcode: null,
    admLevel: 0,
    levelCode: 'country',
    nameEn: str(country!.properties.adm0_name),
    nameBn: 'বাংলাদেশ',
    center: [
      round6(num(country!.properties.center_lon)),
      round6(num(country!.properties.center_lat)),
    ],
  });

  const nameDistricts = readNames(namesDir, 'districts.json');
  const nameUpazilas = readNames(namesDir, 'upazilas.json');
  const nameUnions = readNames(namesDir, 'unions.json');

  for (const f of readFeatures(codDir, 'bgd_admin1.geojson')) {
    const p = f.properties;
    const pcode = str(p.adm1_pcode);
    areas.push({
      pcode,
      parentPcode: str(p.adm0_pcode),
      admLevel: 1,
      levelCode: 'division',
      nameEn: str(p.adm1_name),
      nameBn: DIVISION_NAMES_BN[pcode] ?? null,
      center: [round6(num(p.center_lon)), round6(num(p.center_lat))],
    });
  }

  const districtNameRow = new Map<string, NameRow>();
  for (const f of readFeatures(codDir, 'bgd_admin2.geojson')) {
    const p = f.properties;
    const pcode = str(p.adm2_pcode);
    const nameEn = str(p.adm2_name);
    const wanted = DISTRICT_ALIASES[nameEn] ?? nameEn;
    const row = nameDistricts.find((d) => d.name.toLowerCase() === wanted.toLowerCase());
    if (row) districtNameRow.set(pcode, row);
    else report.push(`- District ${nameEn} (${pcode}): no Bengali name`);
    areas.push({
      pcode,
      parentPcode: str(p.adm1_pcode),
      admLevel: 2,
      levelCode: 'district',
      nameEn,
      nameBn: row?.bn_name ?? null,
      center: [round6(num(p.center_lon)), round6(num(p.center_lat))],
    });
  }

  const upazilaNameRow = new Map<string, NameRow>();
  for (const f of readFeatures(codDir, 'bgd_admin3.geojson')) {
    const p = f.properties;
    const pcode = str(p.adm3_pcode);
    const nameEn = str(p.adm3_name);
    const isUpazila = pcode.slice(6, 8) === '00';
    let nameBn: string | null = null;
    if (isUpazila && UPAZILA_NAMES_BN[pcode] !== undefined) {
      nameBn = UPAZILA_NAMES_BN[pcode];
    } else if (isUpazila) {
      const district = districtNameRow.get(str(p.adm2_pcode));
      const match = district
        ? matchName(
            nameEn,
            nameUpazilas.filter((u) => u.district_id === district.id),
          )
        : undefined;
      if (match) {
        nameBn = match.row.bn_name;
        upazilaNameRow.set(pcode, match.row);
        if (match.how === 'fuzzy')
          reviewed.push(`- ${nameEn} (${pcode}) ← ${match.row.name} / ${match.row.bn_name}`);
      } else {
        report.push(
          `- Upazila ${nameEn} (${pcode}, district ${str(p.adm2_name)}): no Bengali name`,
        );
      }
    } else {
      nameBn = CITY_CORPORATION_NAMES_BN[pcode] ?? null;
      if (nameBn === null) report.push(`- City corporation ${nameEn} (${pcode}): no Bengali name`);
    }
    areas.push({
      pcode,
      parentPcode: str(p.adm2_pcode),
      admLevel: 3,
      levelCode: isUpazila ? 'upazila' : 'city_corporation',
      nameEn,
      nameBn,
      center: [round6(num(p.center_lon)), round6(num(p.center_lat))],
    });
  }

  const known = new Set(areas.map((a) => a.pcode));
  let unionsWithoutBn = 0;
  for (const f of readFeatures(codDir, 'bgd_adminpoints.geojson')) {
    const p = f.properties;
    if (num(p.admin_level) !== 4) continue;
    const parent = upazilaPcodeFromPointCode(str(p.adm3_pcode));
    if (!known.has(parent)) {
      report.push(
        `- Union ${str(p.adm4_name)} (${str(p.adm4_pcode)}): parent ${parent} not found, skipped`,
      );
      continue;
    }
    const upazila = upazilaNameRow.get(parent);
    const nameEn = str(p.adm4_name);
    // "Trishal Paurashava": a municipality, named after its town.
    const town = POURASHAVA.exec(nameEn)?.[1];
    const unions = upazila ? nameUnions.filter((u) => u.upazilla_id === upazila.id) : [];
    let nameBn: string | null;
    if (town !== undefined) {
      const base =
        matchName(town, unions)?.row.bn_name ??
        (upazila && matchName(town, [upazila]) ? upazila.bn_name : undefined);
      nameBn = base === undefined ? null : `${base} পৌরসভা`;
    } else {
      nameBn = matchName(nameEn, unions)?.row.bn_name ?? null;
    }
    if (nameBn === null) unionsWithoutBn++;
    areas.push({
      pcode: str(p.adm4_pcode),
      parentPcode: parent,
      admLevel: 4,
      levelCode: town === undefined ? 'union' : 'pourashava',
      nameEn,
      nameBn,
      center: [round6(num(p.x_coord)), round6(num(p.y_coord))],
    });
  }

  const count = (level: LevelCode) => areas.filter((a) => a.levelCode === level).length;
  const withBn = (level: LevelCode) =>
    areas.filter((a) => a.levelCode === level && a.nameBn !== null).length;
  const summary = (
    [
      'country',
      'division',
      'district',
      'upazila',
      'city_corporation',
      'union',
      'pourashava',
    ] as const
  )
    .map((l) => `| ${l} | ${count(l)} | ${withBn(l)} |`)
    .join('\n');

  const markdown = `# Bengali names: coverage and review

Generated by \`src/locations/geo-import/build-reference.ts\` from ${release} and
nuhil/bangladesh-geocode (MIT). Names were matched to pcodes once, within the
same parent; the runtime only ever joins by pcode. Fix a name by editing
\`bgd-admin-cod-ab-v03.json\` (by pcode) — or improve the aliases in the script
and regenerate.

| level | areas | with Bengali name |
| ----- | ----- | ----------------- |
${summary}

## Matched by spelling similarity — please review

${reviewed.length > 0 ? reviewed.join('\n') : '_None._'}

## Missing

${report.length > 0 ? report.join('\n') : '_None._'}
${unionsWithoutBn > 0 ? `- ${unionsWithoutBn} unions/pourashavas have no Bengali name (the name dataset has ${nameUnions.length} unions; COD-AB has ${count('union') + count('pourashava')}).` : ''}

## Not in the source data at all

- **City-corporation wards** (DNCC, DSCC, … wards): COD-AB v03 has city corporations as whole polygons, no wards.
- **Metropolitan (police) thanas** such as Mirpur, Gulshan, Kotwali: not an administrative level in COD-AB. Tenants for such areas use a center + radius boundary, or a boundary drawn and verified by hand.
- **Union polygons**: ADM4 comes as points only, so unions have a centre and no boundary.
`;

  // NFC everywhere: sources mix precomposed য় (U+09DF) with য + nukta, which
  // look identical and compare unequal.
  for (const area of areas) {
    area.nameEn = area.nameEn.normalize('NFC');
    if (area.nameBn !== null) area.nameBn = area.nameBn.normalize('NFC');
  }

  return {
    file: {
      source: 'HDX COD-AB Bangladesh — Subnational Administrative Boundaries (BBS via OCHA)',
      licence: 'CC BY-IGO 3.0',
      attribution:
        'Administrative boundaries: Bangladesh Bureau of Statistics (BBS), via OCHA / HDX, CC BY 3.0 IGO',
      release,
      namesSource: 'nuhil/bangladesh-geocode (MIT)',
      areas,
    },
    report: markdown,
  };
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`missing ${name} <dir>`);
  return value;
}

if (require.main === module) {
  const { file, report } = buildReference(arg('--cod'), arg('--names'));
  // One area per line keeps the file diffable when a release changes.
  const body = file.areas.map((a) => `    ${JSON.stringify(a)}`).join(',\n');
  const { areas: _areas, ...meta } = file;
  const head = JSON.stringify(meta, null, 2).slice(0, -2);
  writeFileSync(REFERENCE_PATH, `${head},\n  "areas": [\n${body}\n  ]\n}\n`);
  writeFileSync(REPORT_PATH, report);
  console.log(`wrote ${file.areas.length} areas to ${REFERENCE_PATH}`);
}
