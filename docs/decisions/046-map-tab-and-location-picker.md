# ADR 046: The app's Map tab and the reusable LocationPicker

**Status:** Accepted (2026-10-06). Builds on [ADR 043](043-self-hosted-pmtiles-basemap.md) (base map),
[ADR 044](044-geo-provider-and-map-screens.md) (geo provider layer) and [ADR 045](045-map-features-api.md) (map data API).

**Code:**

- API: migration `0041_map_kinds_and_client_settings`; `apps/api/src/map/map-config.*` (`kinds`, `client`),
  `map-features.*` (`kinds=`), `map-preview.*` (`GET /map/features/:layer/:id`)
- App, map: `apps/mobile/lib/features/map/` — `map_screen.dart`, `map_preview_sheet.dart`, `map_layers_sheet.dart`,
  `application/route_cache.dart`, `application/map_viewport.dart`
- App, shared: `apps/mobile/lib/core/map/` — `location_picker.dart`, `geo_api.dart`, `map_pin_images.dart`,
  `directions.dart`; the post editor's location step now uses `LocationPicker`
- Tests: `test/core/map/location_picker_test.dart`, `test/features/map/map_screen_test.dart`,
  `test/features/map/goldens/` (the preview sheet in Bengali), API unit / e2e / DB specs for kinds and the preview

## Context

The Map tab has to:

- **Show what is near the user:** hospitals, pharmacies, food, gas, banks, bus stands, shops and listings.
- **Stay cheap:** our own tiles and our own data (ADR 043, 045); the only paid call is a road route on an explicit
  tap.
- **Stay correct in Bengali:** MapLibre draws Bengali glyph by glyph, and the shaping spike (ADR 043) has not passed.

Picking a point (post creation, store setup, place marking) needs one shared widget that spends at most one reverse
geocode per stop.

## Decision 1: everything the app tunes comes from `GET /map/config`

Nothing in the app is a hardcoded threshold (CLAUDE.md rule 9). `/map/config` now also returns:

- **`kinds`** (`map_kinds`, a new `json` setting type). The Map tab's toggles, in order. Each kind has a code, an icon
  key, Bengali and English labels, and its sources. A source is a table (`posts`, `stores`, `places`, `emergency`,
  `bus_stops`) with categories (and their descendants) or emergency service types. A feature takes the first kind it
  matches; matching no kind gives `kind: null`. The seed:

  | Kind        | Sources                                                                 |
  | ----------- | ----------------------------------------------------------------------- |
  | `hospital`  | places in `hospital-doctor-chambers`; emergency `hospital`, `ambulance` |
  | `pharmacy`  | places in `pharmacy`; emergency `pharmacy_24h`                          |
  | `food`      | places in `restaurant-food`; posts in `homemade-food`                   |
  | `gas`       | posts in `gas-cylinder`; emergency `gas`                                |
  | `bank`      | places in `bank-atm`                                                    |
  | `bus_stand` | stops of active transport routes                                        |
  | `shops`     | stores; places in `local-shop-directory`                                |
  | `listings`  | every other post                                                        |

  Admins can change the mapping without an app release.

- **`client`.** The timings the app obeys:

  | Setting                          | Default | What it controls                                      |
  | -------------------------------- | ------- | ----------------------------------------------------- |
  | `geo_picker_idle_debounce_ms`    | 600     | how long the map must stay still before a lookup      |
  | `geo_autocomplete_debounce_ms`   | 400     | how long typing must pause before a search            |
  | `geocode_autocomplete_min_chars` | 3       | shortest query sent (already enforced by the server)  |
  | `map_search_area_move_ratio`     | 0.3     | share of the viewport moved before "Search this area" |
  | `map_pin_label_min_zoom`         | 17      | zoom from which pins get a name image                 |
  | `map_pin_label_max`              | 40      | most name images on the map at once                   |

`GET /map/features` takes `kinds=`: only those kinds, clustered per (layer, kind), and each feature carries its `kind`.
`map_features()` gained the parameter. The 11-argument version was dropped in 0041, because a new signature cannot be
`CREATE OR REPLACE`d; the API is its only caller and moved in the same change.

## Decision 2: a preview endpoint, not heavier features

`GET /map/features/:layer/:id?tenant=` returns a photo (card-size cover with its thumbhash), public phones and an
address.

- **How it reads.** In the feature's own tenant, as an anonymous visitor, so only what that table's public-read
  policy shows. There is no new `SECURITY DEFINER` function.
- **Why a separate endpoint.** A tap costs one small request; 500 map features stay light.
- **Posts never carry a number.** Their call button goes through the post's contact action (ADR 036): that call is the
  lead.
- **Not found.** A hidden post, the wrong layer or another tenant is a 404 (`MAP_FEATURE_NOT_FOUND`).

## Decision 3: the Map tab

- **Opens at the user** (one location request). If the location is denied or off, it opens at the area's centre.
  Location and config are settled first, so opening the tab makes exactly one feature request.
- **Fetches only on explicit actions:** opening the tab, changing a toggle, tapping a cluster (which zooms to its
  `expansion_zoom` and asks once), or the "এই এলাকায় খুঁজুন" button.
- **"এই এলাকায় খুঁজুন".** A pan never refetches. The button appears once the camera rests at another zoom level or
  `map_search_area_move_ratio` of the viewport away.
- **Pins are icons only.** Eight icons are drawn once by Flutter from the Material icon font and added with
  `addImage`. Every pin is one GPU symbol in one GeoJSON source; no Flutter widget per pin.
- **Names on pins are images, never map text.** From `map_pin_label_min_zoom`, the nearest `map_pin_label_max` pins
  get their name shaped by Flutter and drawn as an image.
  - MapLibre cannot remove a style image, but re-adding a name replaces it. So the images live in `map_pin_label_max`
    fixed slots, and the least recently used slot is redrawn.
  - Image memory is bounded however long the session runs.
- **Map / list.** Both show the same results. The list is sorted nearest first from the user; a cluster row zooms in.
- **Preview sheet:**
  - photo, the Bengali name as a Flutter `Text`, kind, and open/closed;
  - the straight-line distance (`/map/distance`, free) and the address;
  - **Call:** the dialer with the first public number, or the post's contact action;
  - **Directions:** `google.navigation:` when Google Maps is installed, else the Google Maps web link in the browser.
    Coordinates only, no turn-by-turn. The Android `<queries>` entry lets the app see whether Google Maps is
    installed;
  - **"রাস্তায় কত দূর?":** one `POST /geo/route` per place and mode per session (`RouteCache`; a failure is not
    cached). Reopening the sheet shows the answer without a second call.
- **Attribution.** The OSM + Protomaps credit is always visible on the map (BaseMap). Barikoi's credit appears under a
  route answer and under Barikoi addresses and search results.
- **On a 2 GB phone.** Rendering stays on the GPU, and the source is updated only at rest, never per frame. Pin images
  are 8 plus at most 40 name slots, and the server caps responses at `map_features_max` (500).
  - **Not verified on a device yet.** Check it on a 2 GB Android phone before launch, together with the VPS benchmark
    (ADR 045).

## Decision 4: `LocationPicker`, one widget for every "where is it?"

`apps/mobile/lib/core/map/location_picker.dart`, with `purpose` set to `post_location`, `store_setup` or
`place_marking`. Store setup and place marking have no app screen yet; the widget is ready for them.

- **The pin is fixed in the middle and the map moves under it.** That is cheaper and steadier than dragging a marker.
- **Lookups.**
  - **When:** every camera frame restarts the idle timer, and only after `geo_picker_idle_debounce_ms` of stillness is
    the point looked up.
  - **What:** `/locations/lookup` (our own `geo_areas`, free) shows the area name at once, and **one**
    `/geo/reverse?purpose=` fills the street address when it arrives.
  - **What it never does:** repeated idles, jitter and frames cost nothing extra. A point the app moved to itself (GPS,
    a search result) is not looked up again on its idle.
- **Search.** `/geo/autocomplete`, debounced, with a minimum length from settings and our own results first. Picking a
  result already names the place, so it costs no reverse call.
- **"আমার লোকেশন"** moves the map to the user's location.
- **Editable address.** The address text can be edited, and the confirmed text is what gets saved
  (`PickedLocation.label`: the text, else the area name).
- **Failures.** If the geo endpoints fail, a notice says to continue: the pin plus the area name, or the pin alone
  offline, is enough.
- **Purpose-agnostic.** The geo calls moved from `PostsApi` to `GeoApi`, so the picker doesn't depend on posts.

## Decision 5: the web map (`/map`) and the React LocationPicker, at parity

Code: `apps/web/src/components/map/` — `map-explorer.tsx`, `map-preview-panel.tsx`, `location-picker.tsx` and their
`*-lazy.tsx` wrappers; `apps/web/src/lib/map/` — `view.ts`, `pin-images.ts`, `route-cache.ts`, `directions.ts`. Proxies:
`/api/map/features`, `/api/map/preview`, `/api/map/distance`; `/api/geo/route` (ADR 044).

- **The stack.** MapLibre GL with the PMTiles protocol, registered once in the lazily loaded map module
  (`maplibre.ts`). Styles come from `@amar-elaka/map-style` with the tile URL and label language from `/map/config`.
  Light/dark follows the page theme.
- **Lazy, not bloating other pages.** The explorer and the picker are `next/dynamic` chunks (`ssr: false`).
  - **Build numbers:** `/map` first load went from 158 kB to 120 kB. `/post/new` is 191 kB (+2 kB for the lazy wrapper
    and the geo actions). `/` is unchanged at about 108 kB.
  - MapLibre, PMTiles and the styles download only when a map is shown.
- **The same Map tab as the app.**
  - **Features:** `map_kinds` toggles with the same pin icons (inline SVG, added with `addImage`) and "open now".
  - **When it asks:** server clusters; one request on open; requests on a toggle change, a cluster click and
    "এই এলাকায় খুঁজুন"; never one per pan.
  - **Names in HTML:** at `map_pin_label_min_zoom` and above, the nearest `map_pin_label_max` pins get their name as
    HTML markers. Bengali is shaped by the browser, never map text.
  - **Map / list:** the same results; the list is nearest first.
  - **Preview panel:** photo, name, kind, open/closed, straight-line distance, address, and these actions:
    - a `tel:` link for public numbers;
    - the post or store page for contact (lead tracking stays there);
    - the Google Maps link (coordinates only);
    - "রাস্তায় কত দূর?": one `/geo/route` per place per browser session, and a failure is not cached.
  - **Attribution:** OSM and Protomaps in the map's attribution control; Barikoi's credit under its answers.
- **Location on the web.** The page uses the visitor's location without a prompt only if permission was already
  granted. Otherwise it opens at the shared view or the area's centre, and "আমার লোকেশন" asks. A browser prompt on
  page load would be intrusive; the app asks on open as phone apps do.
- **Shareable URL.** `?lat=&lng=&z=&kinds=&open=1&view=list`, kept current with `history.replaceState` (no navigation,
  no history entries). The server parses and validates it (`parseMapView`), and a shared link opens exactly that
  view.
- **React `LocationPicker`.** The same behaviour as the app's: a fixed centre pin; one `/geo/reverse?purpose=` per
  camera stop after `geo_picker_idle_debounce_ms`; the area at once from `/locations/lookup`; debounced
  `/geo/autocomplete` with our own results first and no reverse call for a picked result; an editable address;
  failures that don't block. The geo calls are injected (`PickerGeo`); the post editor passes its server actions with
  `purpose=post_location`.
- **What "saved" means for a post.** A post stores its point, not an address text (no such column). The confirmed text
  is kept in the draft and shown on the preview card. Stores and places do have `address_text`, which their screens
  will save when they exist.
- **Tests (Playwright, against the stub API):**
  - one features request on open for every kind; list, preview, one road per session, and the directions and call
    links;
  - panning shows "এই এলাকায় খুঁজুন" without refetching;
  - layers and open now go into the URL, and a shared link opens its view;
  - the post picker: area and address on open; a drag is exactly one more reverse; search puts our results first and
    costs no reverse.
  - The geo-secrets CI check is clean on the web build.

## Tests

- **LocationPicker.**
  - Exactly one reverse call per camera stop: a 60-frame drag with 3 idles is one call, and a stop that moves again
    before the debounce is none.
  - The area shows at once and the street address later; the edited text is the confirmed one.
  - When the endpoints fail, the pin and the area are enough.
  - Search: minimum length, debounce, our results first, and a picked result costs no reverse call.
  - The answers are the API FakeProvider's.
- **Map tab:**
  - opens at the user and asks for every kind;
  - a pan doesn't refetch, and "Search this area" refetches;
  - the layer sheet shows icons and a toggle change refetches;
  - list and cluster zoom;
  - the preview: distance, open now, one route per session, and directions with and without Google Maps.
- **Golden:** the preview sheet in Bengali, light and dark, with conjunct-heavy text.
- **API:**
  - kinds per feature and the kinds filter (DB);
  - `kinds=` and the seeded config (e2e);
  - the preview for a place, an emergency service and a post, the 404s and RLS, with zero provider calls (e2e).

## Consequences

- **0041 drops the 11-argument `map_features`.** It is replaced by the 12-argument one; no column changes.
- **A new setting value type `json`.** The registry validates its shape, as it does for every setting.
- **Only features that match a kind show on the Map tab.** Police stations, schools and government offices match no
  seeded kind, so they don't appear there. Add a kind to `map_kinds` to show them. The web map (layers) is unchanged.
