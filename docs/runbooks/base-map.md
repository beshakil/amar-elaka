# Base map tiles

**Last exercised: locally, 2026-10-05** — `storage/map/bd-20261005.pmtiles`, **199 MB** (needs the `pmtiles` CLI).
Never on a server.

```sh
MAP_TILES_PATH=/app/storage/map scripts/map/build-tiles.sh [--maxzoom N]
```

It extracts Bangladesh from a Protomaps daily build into one versioned archive, writes `current.json` (what
`GET /map/config` reads), fetches glyphs, sprites and Noto Sans Bengali, and keeps the previous archive for clients
that loaded the old config. Rebuild monthly or when OSM changes matter. Never point clients at tile.openstreetmap.org or
Barikoi tiles.
