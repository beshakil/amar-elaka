# ADR 038 — Mobile feed and post detail, built for 2 GB phones

**Status:** Accepted (2026-09-28). Code: `apps/mobile/lib/features/feed`, `apps/mobile/lib/features/post_detail`,
`apps/mobile/lib/core/{media,platform}`, `apps/mobile/lib/core/design/widgets/network_photo.dart`; Dart models in
`packages/shared-types/dart/lib/src/{feed,posts/post_detail.dart}`. Builds on ADR 035 (feed), 036 (detail, contacts),
037 (saved).

## Decisions

**1. The home tab is the feed.**

- **Top:** a scope switcher (আমার এলাকা / আশেপাশে / সারা দেশ → `area` / `nearby` / `country`) and category chips.
- **Filter sheet:** a category with filterable fields gets a filter button. The sheet is the schema-driven
  `DynamicFilters`, now with `initialState`, so it reopens as it was left. It is applied only on "ফলাফল দেখুন", and a
  panel with problems (min above max) can't be applied. The API gets `filters` as `{"field": {"op": "value"}}`.
- **List:** `CustomScrollView` + `SliverList.separated`. The next page is requested by cursor six items before the
  end; pull to refresh reloads the first page. Store, landmark, emergency and bazar-price cards sit where the API places
  them. The emergency card dials with one tap.
- **Distance:** the phone's position is used only if location is already allowed (`positionIfAllowed`, never a
  prompt). Otherwise the API uses the area's centre.

**2. It is never a blank screen.**

- Each query's first page is stored in Drift (`FeedCache`, id `<tenant>|<scope|category|filters>`) exactly as the API
  sent it.
- On open, the cached page shows at once while the network loads.
- If the network fails, the cached page stays, with a banner: "অফলাইন — {time}-এর ফিড দেখাচ্ছে".
- With nothing cached and no network, the screen says so and offers a retry.
- A failed refresh keeps what's on screen, now marked offline.
- A generation counter drops a late response for an older query.

**3. The saved heart.**

- It flips at once and flips back (with a message) if the server refuses. A guest is sent to sign in first.
- The feed's cards learn `isSaved` from the API. `FeedService.withSaved` marks them **after** the shared page cache
  (one query on the viewer's own `saved_posts`; the cache key moved to `v2`), so a cached page never holds one person's
  saves. The feed route now reads an optional token (`OptionalJwtAuthGuard`). Similar posts in the detail get the same
  treatment.

**4. The detail (`/posts/:id`, also the notifications' deep link).**

- **Gallery:** swipeable, with a "২/৩" counter. A tap opens a full-screen gallery with pinch zoom (`InteractiveViewer`,
  up to 4×). Swiping is disabled while zoomed in, so it doesn't fight panning.
- **Body:**
  - price, with the price type ("আলোচনা সাপেক্ষে", "/মাস", "ফ্রি");
  - area · distance · category;
  - the fields as a label/value table, labelled from the post's own schema version;
  - the description;
  - the seller card: name, member since, badges, store;
  - similar posts.
- **Sticky bar:** Call · WhatsApp · Save · Share. The owner sees their post's views/contacts/saves instead, and no
  report menu. A sold post can't be contacted.
- **Contact:** Call and WhatsApp always go through `POST /posts/:id/contact` first (the lead, ADR 036). Then:
  - **Call:** opens `tel:`;
  - **WhatsApp:** opens `whatsapp://send?phone=…&text=<the Bengali message>`;
  - **WhatsApp not installed** (`canLaunchUrl` false; `<queries>` declared in the manifest for Android 11+): a sheet
    offers wa.me in the browser, an SMS (another lead, channel `sms`), or copying the number.
  - **The server refuses:** the reason is said in Bengali (limit reached with the number, sign in, channel off, not
    live).
  - **The area requires sign-in** (`loginRequired`): a guest is asked to sign in before any reveal.
- **Other actions:** Report is in the overflow menu (reason + optional text). Share sends the `/s/:code` link.
- **View:** `POST /view` fires once when the screen opens and is never awaited.
- **Install id:** every request carries `X-Install-Id`, a random id stored once on the phone
  (`InstallIdInterceptor`). The API hashes it to dedupe a guest's views and reveals.
- **Leaving the app:** the dialer, WhatsApp, SMS, browser and share sheet are all behind `ExternalApps`
  (url_launcher, share_plus), so tests can assert exactly what would have opened.

**5. Memory on a 2 GB phone.**

- **Right variant, right size:** lists only ever request the **card** variant, decoded at display size
  (`NetworkPhoto.decodeWidth` → `memCacheWidth`). The inline gallery uses card too; only the full-screen gallery loads
  **full**, and its `PageView` keeps just the visible photo and its neighbours.
- **Caches:** `cached_network_image` provides the disk cache. The global `ImageCache` is capped at 48 MB / 200 images
  (`ImageMemory.configure`, down from Flutter's 100 MB / 1000).
- **Placeholders:** thumbhashes (the `thumbhash` package) are decoded once and kept in a 120-entry LRU, not re-decoded
  on every rebuild.
- **Painting:** each card sits in a `RepaintBoundary`, so a heart tap or a photo fading in repaints that card only.
  The detail's bottom bar uses a hairline border rather than an elevation shadow.

## Performance

`integration_test/feed_scroll_perf_test.dart` scrolls 200 feed items (10 pages via the cursor). Its photos are real
encoded images, decoded at card size. The test records the timeline, and `test_driver/perf_driver.dart` writes
`build/feed_scroll.timeline_summary.json`.

Run on the 2 GB phone (or an Android 8 emulator with 2048 MB), in profile mode:

```
flutter drive --profile --driver=test_driver/perf_driver.dart --target=integration_test/feed_scroll_perf_test.dart
```

Fill in from the summary JSON, alongside DevTools' memory view while scrolling:

| Metric                                                                     | Budget (60 Hz) | Measured |
| -------------------------------------------------------------------------- | -------------- | -------- |
| `average_frame_build_time_millis`                                          | < 8 ms         | —        |
| `90th_percentile_frame_build_time_millis`                                  | < 12 ms        | —        |
| `99th_percentile_frame_build_time_millis`                                  | < 16 ms        | —        |
| `average_frame_rasterizer_time_millis`                                     | < 8 ms         | —        |
| `99th_percentile_frame_rasterizer_time_millis`                             | < 16 ms        | —        |
| `missed_frame_build_budget_count` / `missed_frame_rasterizer_budget_count` | 0–2            | —        |
| Dart heap + image cache after 200 items (DevTools Memory)                  | flat, < 150 MB | —        |

**No numbers were measured when this was written.** The build environment (WSL, no Android device or emulator, no
Linux desktop toolchain) can't profile a phone, and desktop numbers would say nothing about a 2 GB device. The
scenario itself runs headless in CI terms: 200 items, 10 pages, no errors.

## Consequences

- New dependencies: `cached_network_image`, `url_launcher`, `share_plus`, `thumbhash`, and `flutter_driver` (SDK, dev).
- Tests:
  - card states;
  - the feed: scope, category, filters as JSON, paging, refresh, offline cache with banner, never blank, hearts,
    guest;
  - the detail: gallery and zoom, contact via endpoint, WhatsApp app / missing, a turned-off channel, errors in
    Bengali, sign-in gate, save/share, report, owner view, gone and offline;
  - goldens: cards and the detail, Bengali, light and dark;
  - the feed → filter → detail → save → call scenario, headless and on a device.
- Not yet: the store screen (the seller card shows the store but doesn't open it), and the Android App Link for
  `/s/:code` (ADR 036). Both come with the store and deep-link work.
