#!/usr/bin/env bash
# Builds the self-hosted Bangladesh base map (ADR 043).
#
#   1. Extracts Bangladesh (bbox + margin) from a Protomaps daily planet build
#      (built from OpenStreetMap) into ONE versioned file, bd-<YYYYMMDD>.pmtiles.
#   2. Writes current.json, the manifest GET /api/v1/map/config reads, so the
#      archive's name can change (a new build = a new URL = free cache
#      invalidation) while clients find it through one stable file.
#   3. Fetches the glyphs (Noto Sans Regular/Medium) and the v4 light/dark
#      sprites, pinned to one basemaps-assets commit, plus Noto Sans Bengali as
#      font files (fonts/bengali/) for the styles' `font-faces`.
#   4. Keeps the previous archive (clients that loaded the old config still
#      read it), deletes older ones, and prints the size.
#
# Output goes to $MAP_TILES_PATH (default ./storage/map), which the API serves at
# /tiles. Max zoom comes from platform_settings.map_tiles_max_zoom (CLAUDE.md
# rule 9), read with psql from DATABASE_URL; --maxzoom overrides it.
#
# Needs: the pmtiles CLI (https://github.com/protomaps/go-pmtiles/releases, not a
# repo dependency; or set PMTILES=/path/to/pmtiles), curl, node, sha256sum, and
# psql unless --maxzoom is given. Refresh monthly (ADR 043).
#
# Usage:
#   scripts/map/build-tiles.sh                      # latest build, max zoom from settings
#   scripts/map/build-tiles.sh --maxzoom 14 --build 20261005
#   scripts/map/build-tiles.sh --dry-run            # size only, nothing written
#   scripts/map/build-tiles.sh --assets-only        # fonts + sprites only
#   scripts/map/build-tiles.sh --out apps/e2e/fixtures/map --maxzoom 6 --name bd-fixture --keep 0
set -euo pipefail

# Bangladesh is 88.01–92.68 E, 20.59–26.63 N; the margin keeps border towns'
# surroundings (and the Bay off Cox's Bazar / Teknaf) on the map.
BBOX="87.95,20.55,92.75,26.75"
BUILDS_URL="https://build-metadata.protomaps.dev/builds.json"
PLANET_URL="https://build.protomaps.com"
# Pinned: fonts and sprites change rarely; bump deliberately and check the map.
ASSETS_COMMIT="028c18f713baecad011301ff7a69acc39bcc2ae7"
ASSETS_URL="https://codeload.github.com/protomaps/basemaps-assets/tar.gz/${ASSETS_COMMIT}"
FONTS=("Noto Sans Regular" "Noto Sans Medium")
# Bengali as real font files for the styles' `font-faces` (MapLibre JS 6, Android
# SDK 11.13+, iOS 6.18+): the renderer shapes conjuncts with them (HarfBuzz /
# the browser), which glyph-per-codepoint PBFs can't. Pinned, OFL licence.
NOTO_COMMIT="86eb2ddc3a2e97cb9747fd9069ee5d47880e3305"
NOTO_BENGALI_URL="https://raw.githubusercontent.com/notofonts/notofonts.github.io/${NOTO_COMMIT}/fonts/NotoSansBengali/hinted/ttf"
BENGALI_WEIGHTS=(Regular Medium)
SPRITES=(light light@2x dark dark@2x)
# Cloudflare (non-Enterprise) caches files up to 512 MB; warn before that.
CACHEABLE_MAX_BYTES=$((450 * 1024 * 1024))

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PMTILES="${PMTILES:-pmtiles}"
OUT="${MAP_TILES_PATH:-}"
MAXZOOM=""
BUILD=""
NAME="bd"
KEEP=1
DRY_RUN=0
ASSETS=1
TILES=1

die() { echo "build-tiles: $*" >&2; exit 1; }
human() { node -e 'const b=+process.argv[1];console.log(b>=1048576?(b/1048576).toFixed(1)+" MB":(b/1024).toFixed(0)+" KB")' "$1"; }
env_value() { [ -f "$ROOT/.env" ] && grep -E "^$1=" "$ROOT/.env" | tail -1 | cut -d= -f2- || true; }

while [ $# -gt 0 ]; do
  case "$1" in
    --maxzoom) MAXZOOM="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --assets-only) TILES=0; shift ;;
    --skip-assets) ASSETS=0; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

OUT="${OUT:-$(env_value MAP_TILES_PATH)}"
OUT="${OUT:-$ROOT/storage/map}"
case "$OUT" in /*) ;; *) OUT="$ROOT/${OUT#./}" ;; esac
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] || die "--name must be lowercase letters, digits and dashes"
[[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep must be a number"

fetch_assets() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo "Fetching fonts and sprites (basemaps-assets ${ASSETS_COMMIT:0:7})…"
  curl -fsSL --retry 3 --max-time 300 "$ASSETS_URL" | tar xz -C "$tmp" --strip-components=1
  mkdir -p "$OUT/fonts" "$OUT/sprites/v4"
  for font in "${FONTS[@]}"; do
    [ -s "$tmp/fonts/$font/2304-2559.pbf" ] || die "$font has no Bengali glyph range (2304-2559)"
    rm -rf "$OUT/fonts/$font"
    cp -R "$tmp/fonts/$font" "$OUT/fonts/$font"
  done
  cp "$tmp/fonts/OFL.txt" "$OUT/fonts/OFL.txt"
  mkdir -p "$OUT/fonts/bengali"
  for weight in "${BENGALI_WEIGHTS[@]}"; do
    curl -fsSL --retry 3 --max-time 120 -o "$OUT/fonts/bengali/NotoSansBengali-$weight.ttf" \
      "$NOTO_BENGALI_URL/NotoSansBengali-$weight.ttf"
  done
  cp "$tmp/fonts/OFL.txt" "$OUT/fonts/bengali/OFL.txt"
  for sprite in "${SPRITES[@]}"; do
    cp "$tmp/sprites/v4/$sprite.json" "$tmp/sprites/v4/$sprite.png" "$OUT/sprites/v4/"
  done
  echo "  fonts: ${FONTS[*]} + Noto Sans Bengali ($(du -sh "$OUT/fonts" | cut -f1)), sprites: v4 light/dark"
}

build_tiles() {
  command -v "$PMTILES" >/dev/null || die "pmtiles CLI not found (install go-pmtiles or set PMTILES=)"

  if [ -z "$MAXZOOM" ]; then
    command -v psql >/dev/null || die "psql not found: pass --maxzoom or install psql"
    local db="${DATABASE_URL:-$(env_value DATABASE_URL)}"
    [ -n "$db" ] || die "DATABASE_URL not set: pass --maxzoom"
    # platform_settings is behind RLS: read it as the system role for this
    # transaction, exactly as the API's SettingsService does (never bypassed).
    MAXZOOM="$(psql "$db" -qtAX -v ON_ERROR_STOP=1 <<'SQL'
\o /dev/null
begin;
select set_config('app.role', 'system', true);
\o
select value #>> '{}' from platform_settings where key = 'map_tiles_max_zoom';
commit;
SQL
)"
    [ -n "$MAXZOOM" ] || die "map_tiles_max_zoom is not seeded (run the migrations)"
    echo "Max zoom $MAXZOOM (platform_settings.map_tiles_max_zoom)"
  fi
  [[ "$MAXZOOM" =~ ^[0-9]+$ ]] && [ "$MAXZOOM" -le 15 ] || die "max zoom must be 0-15 (Protomaps' deepest is 15)"

  if [ -z "$BUILD" ]; then
    BUILD="$(curl -fsS --retry 3 --max-time 60 "$BUILDS_URL" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const keys = JSON.parse(s).map((b) => b.key).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort();
        if (!keys.length) process.exit(1);
        console.log(keys.at(-1).replace(".pmtiles", ""));
      });')" || die "could not read the Protomaps build list"
  fi
  [[ "$BUILD" =~ ^[0-9]{8}$ ]] || die "--build must be YYYYMMDD"
  local source="$PLANET_URL/$BUILD.pmtiles"
  local file="$NAME-$BUILD.pmtiles"

  echo "Extracting $BBOX, z0-$MAXZOOM from $source"
  if [ "$DRY_RUN" = 1 ]; then
    "$PMTILES" extract "$source" "/tmp/$file" --bbox="$BBOX" --maxzoom="$MAXZOOM" --dry-run 2>&1 | tail -2
    return
  fi

  mkdir -p "$OUT"
  local tmp="$OUT/.$file.partial"
  rm -f "$tmp"
  "$PMTILES" extract "$source" "$tmp" --bbox="$BBOX" --maxzoom="$MAXZOOM" --download-threads=4
  "$PMTILES" verify "$tmp" >/dev/null || die "the extracted archive failed pmtiles verify"
  mv -f "$tmp" "$OUT/$file"

  local bytes sha
  bytes="$(stat -c %s "$OUT/$file")"
  sha="$(sha256sum "$OUT/$file" | cut -d' ' -f1)"
  node -e '
    const [file, version, maxZoom, bbox, bytes, sha256, source, out] = process.argv.slice(1);
    const manifest = { version, file, maxZoom: +maxZoom, bbox: bbox.split(",").map(Number),
      bytes: +bytes, sha256, source, builtAt: new Date().toISOString() };
    require("fs").writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  ' "$file" "$BUILD" "$MAXZOOM" "$BBOX" "$bytes" "$sha" "$source" "$OUT/.current.json.partial"
  mv -f "$OUT/.current.json.partial" "$OUT/current.json"

  # Keep the newest $KEEP previous archives of this name; delete the rest.
  local old
  old="$(ls -1 "$OUT" | grep -E "^$NAME-[0-9]{8}\.pmtiles$" | grep -vx "$file" | sort -r | tail -n +$((KEEP + 1)) || true)"
  for f in $old; do rm -f "$OUT/$f"; echo "  removed old archive $f"; done

  echo
  echo "Built $OUT/$file"
  echo "  size: $(human "$bytes") ($bytes bytes), z0-$MAXZOOM, sha256 ${sha:0:12}…"
  if [ "$bytes" -gt "$CACHEABLE_MAX_BYTES" ]; then
    echo "  ⚠ UNREASONABLY LARGE for us: over 450 MB. Cloudflare (non-Enterprise) won't cache a"
    echo "    file over 512 MB, so every range request would hit the VPS. Lower map_tiles_max_zoom."
  fi
}

[ "$TILES" = 1 ] && build_tiles
[ "$ASSETS" = 1 ] && [ "$DRY_RUN" = 0 ] && fetch_assets
echo "Done. Served at /tiles by the API (MAP_TILES_PATH=$OUT)."
