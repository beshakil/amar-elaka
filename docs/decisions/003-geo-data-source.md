# ADR 003: Geo data source for administrative boundaries

**Status:** Accepted
**Date:** 2026-09-17
**Schema:** [`geo_areas` §3.1](../specs/schema.md), ownership rules [§13.26](../specs/schema.md), rationale [§13.27](../specs/schema.md)

## Context

Every tenant is one upazila (or metro thana). Its boundary polygon decides which tenant owns,
moderates and bills a post or place. We also need the hierarchy (division → district →
upazila → union/ward) for pickers and reporting, stable codes to join other datasets (BBS
Bengali names, the official upazila list, future census data), and lightweight polygons for
map clients.

## Decision

1. **Source:** HDX **Bangladesh COD-AB** (Common Operational Dataset, Administrative
   Boundaries), sourced from the **Bangladesh Bureau of Statistics (BBS)**, levels
   **ADM0–ADM4**.
2. **Licence:** **CC BY 3.0 IGO**. Commercial use is allowed; **attribution is mandatory**
   (see below).
3. **Codes:** store **both** BBS pcodes, `bbs_code_geocode11` (2011 scheme) and
   `bbs_code_geocode15` (2015 scheme), plus `adm_level` (0–4).
4. **Joins:** every join across sources (COD-AB levels, the upazila list, the Bengali name list,
   future data) uses **pcodes, never names**. Names are display-only.
5. **Geometry:** two columns.
   - `boundary`: full precision, for point-in-polygon ownership and buffer distance.
   - `boundary_simplified`: `ST_SimplifyPreserveTopology`, for sending to map clients only.

## Attribution requirement

CC BY 3.0 IGO requires credit wherever the data, or anything derived from it, is shown or
redistributed:

- **Every map view** (web, admin, mobile) that renders boundaries shows, in the map
  attribution control or a visible footer:
  > Administrative boundaries: Bangladesh Bureau of Statistics (BBS), via OCHA / HDX, CC BY 3.0 IGO
- The **About / Licences** page of web and mobile lists the dataset, its HDX page, the licence
  name with a link, the release used (`geo_areas.source_release`), and a statement that the data
  was modified (simplified, reclassified).
- Any **API response that returns boundary geometry** includes an `attribution` field with the
  same text.
- Don't imply BBS or OCHA endorse the product.

The attribution string is user-facing, so it lives in the i18n bundle (`bn` and `en`), not
hardcoded (CLAUDE.md rule 6). The dataset credit itself stays in its original wording.

## Import procedure

GDAL isn't installed on the dev machine, and adding it to the project needs approval
(CLAUDE.md). Run it as a one-off container from the official GDAL image against the dev
database from `infra/docker-compose.dev.yml`. In production, the import runs as the
migration/owner role, never `ae_app`.

### 1. Download and inspect. Don't assume field names.

Download the COD-AB shapefile (or GeoPackage) release from HDX into
`infra/geo/raw/<release>/`, which is git-ignored. Then list layers and fields, because file,
layer and attribute names change between releases:

```sh
docker run --rm -v "$PWD/infra/geo/raw:/data" ghcr.io/osgeo/gdal:ubuntu-small-latest \
  ogrinfo -so -al /data/<release>/<adm3-file>.shp
```

Record the real attribute names in the **field mapping** table below before importing.
Confirm specifically:

- which fields carry the **2011** and **2015** BBS geocodes, and the parent pcode at each level
- whether any Bengali name field exists (expected: no, so Bengali names come from a separate BBS list, joined by pcode)
- the source CRS (expected EPSG:4326)
- the character encoding of name fields

### 2. Load each level into a staging schema

```sh
for LVL in 0 1 2 3 4; do
  docker run --rm --network host -v "$PWD/infra/geo/raw:/data" ghcr.io/osgeo/gdal:ubuntu-small-latest \
    ogr2ogr -f PostgreSQL \
      "PG:host=localhost port=5432 dbname=amar_elaka user=ae_dev password=ae_dev_pass" \
      "/data/<release>/<adm${LVL}-file>.shp" \
      -nln "staging_geo.cod_ab_adm${LVL}" \
      -overwrite \
      -t_srs EPSG:4326 \
      -nlt PROMOTE_TO_MULTI \
      -makevalid \
      -lco GEOMETRY_NAME=geom \
      -lco FID=ogc_fid \
      -lco SPATIAL_INDEX=GIST \
      -lco PRECISION=NO \
      --config PG_USE_COPY YES \
      --config SHAPE_ENCODING UTF-8
done
```

Flag notes:

- `-nlt PROMOTE_TO_MULTI`: mixed Polygon/MultiPolygon becomes MultiPolygon, matching `geography(MultiPolygon,4326)`.
- `-makevalid`: needs GDAL ≥ 3.1. The transform step still runs `ST_MakeValid` and rejects anything that stays invalid.
- `staging_geo` must exist first (created by the import migration). It lives outside `public`, is owned by the owner role, has no `ae_app` grants, and is dropped after a successful transform.
- `--network host` works for a local compose database; for a remote DB, use its host instead.

### 3. Transform staging into `geo_areas`

This step is a migration-style script, written when migrations are written, not now:

1. Build rows for ADM0 → ADM4 **in level order**, so parents exist first.
2. **Upsert by pcode** (`adm_level` + geocode15, falling back to geocode11). Never match by name.
3. Resolve `parent_id` by the parent pcode from the staging row.
4. Set `boundary` = the staged geometry (valid, 4326) cast to geography.
5. Set `centroid` = `ST_PointOnSurface(geom)`.
6. Set `boundary_simplified` = `ST_SimplifyPreserveTopology(geom, tolerance)` cast to geography, using these **starting** tolerances (degrees; tune by eye against the full boundary at typical zoom levels):

   | Level     | Tolerance | ≈ metres |
   | --------- | --------- | -------- |
   | ADM0–ADM1 | 0.005     | ~500 m   |
   | ADM2      | 0.002     | ~200 m   |
   | ADM3      | 0.0005    | ~50 m    |
   | ADM4      | 0.0002    | ~20 m    |

   Simplification is per feature, so neighbouring simplified polygons can overlap or leave
   slivers. That's acceptable for display only, which is why ownership **always** uses `boundary`.

7. Set `level_code`:
   - ADM0 `country`, ADM1 `division`, ADM2 `district`
   - ADM3 → `upazila` **only if the pcode is in the official 494-upazila list** (`infra/geo/reference/upazila-pcodes.csv`, maintained by hand from BBS). Otherwise set `needs_manual_review = true` (see below).
   - ADM4 → `union` or `ward` by parent type; unclear cases get `needs_manual_review = true`.
8. Join Bengali names **by pcode** from the BBS name list into `name_bn`. Rows without a match keep `name_bn` NULL and are reported.
9. Set `source_release` to the release identifier.
10. Rows present in the DB but missing from the new release get `is_active = false`. **Never delete**, because tenants and content reference them.
11. Rebuild `ancestor_ids`.

### 4. Post-import checks (fail the import if any fail)

- Row counts per level match staging.
- ADM3 rows with `level_code = 'upazila'` = **494**. Any other number means the upazila list and the release disagree; investigate before continuing.
- No invalid geometries (`ST_IsValid` on all `boundary`).
- Every row except ADM0 has a `parent_id`, and the child's point-on-surface lies within the parent's boundary (small tolerance allowed).
- Every pcode is unique per level.
- No existing tenant's `geo_area_id` became inactive or changed level. If one did, **stop** and handle it manually, because it changes ownership rules for live content.

## ⚠ ADM3 contains more than upazilas

COD-AB ADM3 includes **urban and legacy features beyond the 494 upazila pcodes**:
city-corporation thanas (metropolitan police thanas) and features that don't line up with the
current upazila list. These can't be classified automatically.

- They're imported with `needs_manual_review = true`, and `level_code` is set provisionally.
- **City-corporation thanas need manual verification** of level (`metro_thana` / `city_corporation`), parent, and boundary against BBS / local government sources before use.
- A trigger on `tenants` rejects any `geo_area_id` that still has `needs_manual_review and manually_verified_at is null`, so an unverified area can't become a tenant by accident.
- The worklist is the `geo_areas` partial index `(adm_level) where needs_manual_review and manually_verified_at is null`.

## Field mapping (fill in from step 1 before first import)

| `geo_areas` column   | COD-AB attribute (ADM3 example) | Verified against release |
| -------------------- | ------------------------------- | ------------------------ |
| `bbs_code_geocode11` | _TBD_                           |                          |
| `bbs_code_geocode15` | _TBD_                           |                          |
| parent pcode         | _TBD_                           |                          |
| `name_en`            | _TBD_                           |                          |
| `name_bn`            | _(separate BBS list, by pcode)_ |                          |

## Alternatives considered

- **GADM:** its licence restricts commercial use, and it doesn't carry BBS pcodes.
- **OpenStreetMap admin boundaries:** ODbL share-alike obligations on derived databases, uneven union/ward coverage in Bangladesh, and no BBS codes.
- **Raw BBS / LGED files:** authoritative, but inconsistently published and formatted. COD-AB is the BBS data already packaged and versioned.

## Consequences

- Ownership decisions depend on a third-party release. Re-imports are pcode-driven upserts with a hard stop if a live tenant's area changes.
- Two geometry columns increase storage, which is modest (a few thousand ADM4 features).
- Attribution must be implemented in all three front ends before any map ships.
- Some urban areas can't host a tenant until someone manually verifies them.
