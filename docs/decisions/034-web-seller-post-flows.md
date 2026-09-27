# ADR 034 — Web: seller login, post creation and "my posts"

**Status:** Accepted (2026-09-27). Code: `apps/web/src/app/{login,post,me}`, `apps/web/src/lib/{auth,posts}`,
`apps/web/src/app/api/{auth,media}`. Parity with the app's post flows (ADR 032) for sellers on a laptop; the full
seller panel comes in week 10. Functional, not polished.

## Decisions

**1. Sign in with a phone and an SMS code, as in the app.**

- Route handlers (`/api/auth/otp/{request,verify}`, `/api/auth/logout`) exchange the code for tokens and keep them in
  **httpOnly, host-only cookies**, as apps/admin does. No token is ever readable by page JavaScript.
- The token is issued for the tenant of the host (`middleware.ts` resolves it), and the device is sent as
  `platformCode: 'web'`.

**2. `/post/*` and `/me/*` are gated in `middleware.ts`.**

- A live session passes. An expired access token is rotated on the way through, and the page gets the new cookies in
  the same request.
- Anyone else goes to `/login?next=…`, and comes back after signing in. Only an in-app path is followed (`safeNext`).
- Pages check again (`requireViewer`, `GET /auth/me`). The API remains the real boundary.
- After a successful login the page does a full load (`window.location.assign`), not `router.replace` + `refresh`:
  those two can race and leave the seller on the login page.

**3. `/post/new` and `/me/posts/[id]/edit`: one page, a section per app step.** Category → details → photos → location
→ contact, with the card preview beside them.

- The details section is the shared React `DynamicForm`. It got `id`, `hideSubmit`, `onStateChange` and
  `defaultState`, all additive, so the page-level "post" button submits it through `form=` and its own validation
  runs unchanged.
- Sends go through server actions (`lib/posts/actions.ts`), with tokens read on the server. Every failure comes back
  as the API's code and details, and becomes a specific Bengali sentence (`lib/posts/errors.ts`, the same wording as
  the app).
- Create uses the draft's `Idempotency-Key`. An edit of a rejected or removed post is `PATCH` + `submit` (back to a
  moderator).

**4. Photos go through this app, in one request each.**

- The API has no CORS, and an open proxy would let anyone make this server PUT anywhere. So the browser sends each
  compressed photo to `/api/media/upload`, which presigns, PUTs to the URL the API just returned, confirms, and
  **waits until the photo is `ready`** before answering with its id.
- The web `UploadQueue` lets `put` return that id (an additive change).
- "Post" while photos are still uploading waits for them (`UploadQueue.settled()`), as the app does; a failed photo
  stops the submit.
- Waiting for `ready` fixes a race that also existed in the app. Posts accept only ready photos, confirm leaves a photo
  `processing`, and a seller who tapped "post" right after the last upload got `POST_MEDIA_INVALID`. The app's
  `DioMediaUploadTransport.confirm` now waits the same way.

**5. The map is Leaflet on OpenStreetMap tiles** (ADR 033; the constants come from
`@amar-elaka/shared-types/map`).

- Click to place the pin or drag it. There's also "my location" (browser geolocation) and address search (Barikoi,
  through our API).
- Each point is reverse-geocoded and checked against the boundary. Outside the boundary is a warning, never a block.
- `@amar-elaka/shared-types` is now also transpiled by web, for its first runtime export. The `./map` subpath has no
  imports, so a client bundle takes only those constants.

**6. Drafts live in the browser's `localStorage`**, one per area and per post (or "new"). They are saved as you type
(400 ms debounce) and restored on the next visit, with a "discard" link.

- The form's raw state is kept, so even half-typed input survives.
- Photos still uploading can't be stored (a `File` isn't serializable); uploaded ones are kept by id.
- Storage errors (full, disabled) never break the editor.

**7. "My posts" tabs are plain links** (full server renders of the list and every count), not client navigations.
Actions call server actions and then `router.refresh()`. Delete and "sold" ask first.

## Consequences

- New dependency: `leaflet` (+ `@types/leaflet`).
- next-intl: a page-level `NextIntlClientProvider` **replaces** the layout's messages rather than adding to them.
  Pages pass every namespace their client components read, including `dynamicForm` and `mediaUploader` for the editor.
- Tests:
  - Vitest: request body, drafts and storage, error messages, per-status actions, `safeNext`, the middleware gate and
    rotation, and the one-trip queue.
  - Playwright against the contract-typed stub API: login and return, the full create flow with a real photo and map
    click, address search, a draft surviving a reload, my posts (counts, rejected note + resubmit, sold with price,
    hide, delete, a Bengali refusal).
- Running Playwright locally in WSL needs Chromium's libs (nss, nspr, alsa). Without sudo, they come from a
  micromamba env on `LD_LIBRARY_PATH`. CI installs them itself.
