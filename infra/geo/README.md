# Geo data

Bangladesh's administrative areas, for `geo_areas` (ADR 003, ADR 026).

| File                                  | What                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference/bgd-admin-cod-ab-v03.json` | Every area (country → divisions → districts → upazilas and city corporations → unions and pourashavas), keyed by COD-AB pcode, with English and Bengali names and a centre. Committed. |
| `reference/pilot-boundaries.geojson`  | Simplified polygons of the pilot district (Mymensingh and its 14 ADM3 areas), for dev and tests. Committed.                                                                            |
| `reference/name-bn-report.md`         | Bengali-name coverage, fuzzy matches to review, and what the open data doesn't have.                                                                                                   |
| `raw/`                                | Downloads (~50 MB). Git-ignored.                                                                                                                                                       |

Data: HDX COD-AB (Bangladesh Bureau of Statistics via OCHA), CC BY 3.0 IGO. Attribution is required
wherever boundaries are shown. Bengali names: nuhil/bangladesh-geocode (MIT).

## Load it

Names, hierarchy and centres, with no boundaries (idempotent, upserts by pcode):

```sh
pnpm --filter @amar-elaka/api geo:import
```

Full-precision boundaries (production). Download "Bangladesh - Subnational Administrative
Boundaries", GeoJSON, from https://data.humdata.org/dataset/cod-ab-bgd, unzip it into `infra/geo/raw/v03/`,
then run:

```sh
pnpm --filter @amar-elaka/api geo:import --boundaries infra/geo/raw/v03
```

The import runs as `ae_migrator` (`MIGRATION_DATABASE_URL`) in one transaction. It fails, and rolls back, if the
post-import checks fail:

- level counts don't match the reference;
- a boundary is invalid;
- an area lies outside its parent;
- a live tenant sits on a retired area.

Union points that the 2023 boundaries place in another upazila are moved there, and each move is reported.

`db:seed` runs the same import with the pilot boundaries.

## Rebuild the reference (a new COD-AB release)

```sh
pnpm --filter @amar-elaka/api exec tsx src/locations/geo-import/build-reference.ts \
  --cod infra/geo/raw/v03 --names infra/geo/raw/bangladesh-geocode
```

`--names` points at the JSON files of https://github.com/nuhil/bangladesh-geocode (`districts.json`,
`upazilas.json`, `unions.json`). After rebuilding, review `name-bn-report.md`.

## Fill a gap

- **A Bengali name:** edit the area's `nameBn` in the reference JSON (find it by pcode), then run `geo:import`.
- **A metro thana or ward:** these aren't in the open data. Give the tenant a centre + radius boundary
  (`PUT /platform/tenants/:id/boundary`) until a verified polygon exists.
