# ADR 032 — Mobile post flows: stepper, drafts that survive anything, my posts

**Status:** Accepted (2026-09-27). Code: `apps/mobile/lib/features/post`, `apps/mobile/lib/core/map`, migration
0029 (API side). Builds on ADR 002 (mobile architecture), 024 (media pipeline), 029 (posts), 030 (moderation).

## Decisions

**1. A stepper, one concern per screen.** Category → details → photos → location → contact → preview. The preview's
button submits, and a result screen follows.

- "Next" asks the current step (`StepGate`). Each step shows its own errors in Bengali and focuses the first one.
- A server refusal sends the user to the step that can fix it: fields → details, photos → photos, contact number →
  contact.
- The same widgets serve edits and "fix and resubmit". They open at the details step with the post's current values.

**2. Reuse, not rebuild.**

- The details step is the Month 1 `DynamicForm`, now drivable from outside: `DynamicFormController.validate()`, and
  `onStateChanged`/`initialState` carrying the raw typed state. Its old API is unchanged.
- The photos step is the Month 1 `UploadQueue` + `MediaPickerField`, one persistent queue per draft
  (`post-draft:<id>`).
- `PostCard` and `PostDetailView` are the widgets the feed and detail page will use. The preview renders them from the
  draft, so "exactly how it will look" holds by construction.

**3. Drafts: nothing typed is ever lost.** `PostDrafts` (Drift, schema v2) is the source of truth until the server
has the post.

- Saved 400 ms after each change, at once on every step change, and at once when the app goes to the background.
- The form's raw state is saved (even "১২ হাজ", mid-word), not the parsed values.
- Photos live in the upload queue's own store.
- On Android a low-memory phone may kill the app while the camera is open. `image_picker.retrieveLostData()` then adds
  the photo that was taken.
- The Post tab lists unfinished drafts: resume or discard.

**4. Submit is idempotent and offline-safe** (`PostSubmitter`):

1. Wait for photos still uploading; a failed photo stops the submit.
2. `POST /posts {submit: true}` with the draft's own `Idempotency-Key`, fixed when the draft was made. An edit is
   `PATCH`, then `submit` if the post was rejected, removed or a draft.
3. On a network error or timeout the draft becomes `queued`. `DraftSync` resends it with the same key when the
   connection returns, so a post whose response was lost comes back as itself, never twice.
   - `DraftSync` is listened to from the app root, because Riverpod 3 pauses providers nobody listens to.
4. On any other error the draft stays editable, with the error code.

**5. The result says what happened.** "Live now", or "under review, usually within X hours". X comes from the tenant
config (`moderation_typical_review_hours`, tenant-overridable).

**6. Location.**

- `flutter_map` with raster tiles. The URL comes from `--dart-define=MAP_TILE_URL`, defaulting to OSM for development.
  Production passes a keyed provider (Barikoi, MapTiler, …), with no code change.
- The pin stays centred while the map moves under it.
- Each resting point gets `/geocode/reverse` (address) and `/posts/ownership` (boundary).
- Outside the area's boundary is a warning naming the area, never a block. The server places the post (ADR 029), and a
  beyond-buffer post is also told it will be reviewed.
- Address search (`/geocode/autocomplete`) is the fallback when GPS is denied or off.

**7. My posts.**

- Tabs: live, in review, sold, expired, rejected/removed, hidden. Each has its count from `GET /posts/me/counts`.
- Status tabs exclude hidden posts (`?hidden=false`); hidden has its own tab.
- Actions follow the status: edit, mark sold (optional price, either digit script), renew/repost, hide/unhide, delete.
  Sold posts can't be deleted, because they are sales history.
- Rejected/removed posts show the reason in words and the moderator's note, with "edit and resubmit".

**8. Errors.** `describePostError` maps every code the post endpoints return to a specific Bengali sentence: what
happened, and what to do.

- The API's English message is never shown.
- An unknown code still names itself, and a 5xx says it's our side.
- A unit test checks that every known code gets its own message.

**9. API additions** (migration 0029, posts module):

- Contact: `contactName`/`contactPhone` (BD mobile, defaulting to the author's profile) and `showWhatsapp`. The view
  carries `contact`, and its phone appears only when `showPhone` is on (always for the owner).
- Lists: `GET /posts/me/counts` and `?hidden=`.
- Moderator note: `moderationNote` in the owner's view. `my_post_moderation_history` now includes a rejection's note,
  which the notification already showed.
- Review time: `moderation.typicalReviewHours` in tenant config.

## 2 GB RAM / Android 8 (the photo step)

The design keeps full-size images out of Dart memory:

- Picker: no resize in the picker (it would decode the full bitmap in Java first).
- Dimensions: read from the image header only.
- Compression: native, with a downsample on decode, and one compression at a time app-wide.
- Uploads: network-bound, 2 at once.
- Thumbnails: decoded at display size (`cacheWidth`, `ResizeImage`).
- Detail photo viewer: builds only the visible page.
- Map: holds fewer tiles (`keepBuffer: 1`, `panBuffer: 0`).

This can't be proven in CI. **Before release, run this on an Android 8.0 (API 26) emulator with 2048 MB RAM, and on a
real low-end phone:**

1. Create a post with 10 camera photos (12 MP+). The app must not restart, and every photo reaches "done".
2. During step 1, when the camera opens, background the app, then return. The photo taken must be in the list
   (lost-data recovery).
3. Force-stop the app on the details step with half-typed text, and reopen. The draft and its text must be there.
4. Airplane mode on the preview, then tap post. You should see "saved, will be sent". Turn airplane mode off: the post
   must appear in My posts exactly once.
5. Scroll My posts with 30+ posts with photos. Watch memory in Android Studio's profiler: it should stay flat, not
   climb.

## Consequences

- New dependencies: `flutter_map`, `latlong2`, `integration_test` (SDK).
- Tests:
  - A widget test for each step, the submit outcomes, My posts, `DraftSync` and the error messages.
  - The happy path, as one scenario run headless in CI (`test/`) and on a device (`integration_test/`).
  - Goldens for the card and the preview, light and dark, with conjunct-heavy Bengali and the real font. Regenerate
    them on Linux, as CI runs: `flutter test --update-goldens test/features/post/goldens`.
- Not yet: the feed and the public post page (they will reuse `PostCard`/`PostDetailView`), push notification of
  results (week 11), and a "your post was sent" message for background sends (`DraftSync.sent` is the hook).
