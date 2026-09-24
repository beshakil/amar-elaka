# ADR 002: Mobile app architecture (apps/mobile)

**Status:** Accepted
**Date:** 2026-09-24
**App:** `apps/mobile`

## Context

`apps/mobile` is the Flutter client — "Week 3 — Client shells" scope: navigation, theming, auth
screens, and tenant bootstrap only, no business features yet. It depends on
`packages/shared-types/dart` (ADR 001) for request/response models rather than duplicating
them.

## Stack

**Riverpod (codegen) + go_router + Dio + Drift** — the same "explicit codegen, minimal magic"
shape as the rest of the stack (Drizzle's raw-SQL migrations, zod-driven DTOs). Alternatives
considered and passed over: `provider`/`bloc` (more ceremony for the same result, and Riverpod's
codegen catches provider-wiring mistakes at compile time that `provider` only catches at
runtime); `Navigator` 1.0/imperative routing (doesn't give declarative redirect logic, which the
splash → tenant-picker → auth → home flow needs); `http`/plain `fetch`-style clients (no
interceptor chain, and CLAUDE.md rule 5 — timeout + retry + typed error on every external call —
needs one). `shared_preferences` (theme/locale only, not tokens) is the one "extra" dependency
beyond the plan's named stack; it's small and standard, not worth hand-rolling.

## Tenant bootstrap: manual picker, not geolocation

`GET /tenants/nearby` exists and would auto-detect the user's tenant, but that needs a location
permission prompt and the `geolocator` package before the user has done anything in the app yet.
`GET /tenants` + a manual picker (`TenantPickerScreen`) needs neither. Given the current scope
(no business features, minimal footprint), the picker ships now; nearby-detection is a drop-in
upgrade later (swap the repository call, add the permission flow) — nothing else in the
bootstrap flow (`TenantBootstrapController`, the cache tables, the redirect logic) depends on
which one is used.

## Auth screens follow the real backend contract

`POST /auth/email/register` requires an existing session
(`@UseGuards(JwtAuthGuard)` in `apps/api/src/auth/auth.controller.ts`) — it links a password to
an _already-authenticated_ account, not a signup flow. The actual new-user paths are phone+OTP
(`/auth/otp/request` + `/auth/otp/verify`, both `@AllowAnyTenant()`) and Google. So
`LoginScreen` leads with phone entry; `EmailLoginScreen` (reached via a "log in with email"
link) is for users who already linked a password from their profile; there's no signup screen.

**Google sign-in is a UI stub.** Wiring the real `google_sign_in` flow needs an Android OAuth
client and SHA-1 fingerprint registered in Google Cloud Console — account-specific setup outside
what can be done from a code change. The button and its tap handler exist
(`login_screen.dart`); the handler is a documented `TODO` until that setup happens, at which
point it calls `POST /auth/google` with the obtained ID token (the request model already exists
on the backend side; add `GoogleAuthRequest` to `shared-types/dart` alongside it).

## Networking

One `Dio` instance (`dio_client.dart`), four interceptors, tenant → auth → refresh → retry:

- **`TenantInterceptor`** sets `X-Tenant-Id` from the persisted tenant id — the header
  `apps/api/src/database/tenant-resolution.middleware.ts` checks first, ahead of
  subdomain/custom-domain resolution (the mechanisms a client with no hostname-based tenancy
  needs).
- **`AuthInterceptor`** sets `Authorization: Bearer <token>` unless the request carries
  `Options.extra['skipAuth'] = true` — set on every endpoint that doesn't need or accept a
  token (otp request/verify, email login, refresh itself, the tenant list).
- **`RefreshInterceptor`** (a `QueuedInterceptor`, so concurrent requests serialize through it)
  refreshes once on a 401 from a request that _did_ send a token, via a single-flight
  `Future<bool>?` guard, and replays the original request on success. On failure it clears the
  session and fires a callback into `SessionSignal` (`core/network/session_signal.dart`) — a
  small Riverpod counter that exists specifically to avoid a network-layer → auth-feature
  import cycle (auth repositories depend on the Dio client; the interceptor can't depend back on
  `AuthController`). `AuthController` and the router both watch it.
- **`RetryInterceptor`** retries only GET/HEAD/DELETE (never POST/PATCH, to avoid double-submits)
  on network errors, timeouts, or a 5xx, with capped exponential backoff.

`api_exception.dart` maps `DioException` → a typed `AppException` (`NetworkException`,
`TimeoutException`, `ApiException` carrying the real `{statusCode, error, message, details}`
body via the `ApiErrorBody` model from `shared-types/dart`, `UnknownApiException`) — the same
"typed exceptions, no raw leakage" rule the backend applies to its own responses (CLAUDE.md),
applied client-side. This is a mapping function repositories call in their `catch` blocks, not a
fifth Dio interceptor — Dio interceptors transform `DioException → DioException`/resolve; they
can't change what type a failed `dio.get()` throws to its caller.

## Local cache (Drift)

`TenantConfigCache` (one row per tenant ever bootstrapped, `enabledCategories` as
JSON-encoded text via a `TypeConverter` — small, tenant-scoped, only ever read as a whole list)
and `EmergencyContactCache` (normalized rows unpacked from `TenantConfig.emergencyNumbers` on
every refresh, queryable directly for the Info tab rather than buried in a blob). `FeedCache` is
a placeholder table only — `apps/api` has no feed endpoint yet, so there's no repository built
on it; it exists because the task named it explicitly, ready for when that feature lands.

One gotcha worth recording: drift's generated `*.g.dart` is a `part of` the file with the
`@DriftDatabase` annotation, so it only resolves types against _that_ file's own imports, not
what the table files it imports transitively pulled in. `TenantCategory` (from
`amar_elaka_api`) and `StringListConverter` (used inside a `TypeConverter` generic) had to be
imported directly into `app_database.dart` even though nothing there names them — `flutter
analyze` catches it immediately if this drifts (as `non_type_as_type_argument` /
`creation_with_non_type` in the generated file) after adding a new `TypeConverter` elsewhere.

## Design system

Tokens are plain `const` Dart classes (`AppColors`, `AppSpacing`, `AppRadii`, `AppElevation`,
`AppTypography`) — no `ThemeExtension` boilerplate at this size — wired into real `ThemeData` in
`app_theme.dart` so `Theme.of(context)` still works for widgets that don't reach for the tokens
directly. `loading_shimmer.dart` is hand-rolled (`AnimationController` + `ShaderMask` +
`LinearGradient`) rather than the `shimmer` package, per "no heavy animation packages" — it's a
~50-line effect, not worth a dependency.

**Bengali line height.** Bengali matras and conjuncts (রু, ক্ট, ...) extend above/below typical
Latin ascender/descender metrics; a Latin-tuned line height (~1.2, Material's default) clips
them. `AppTypography` uses `height: 1.5` and the app sets
`TextHeightBehavior(applyHeightToFirstAscent: false, applyHeightToLastDescent: false)` on the
root `DefaultTextStyle` (`app.dart`'s `MaterialApp.router.builder`) — without the latter, the
_first_ line of any tall-glyph text still clips at the top, because Flutter's default height
behavior applies the height box to the first line's ascent too. Both are load-bearing; don't
"simplify" the line height back down without checking Bengali rendering on a device first.

**Font: Noto Sans Bengali, one variable font file.** Chosen over Hind Siliguri for broader
script/language coverage and because Google's `google/fonts` repository publishes it as a single
variable font (`wdth`/`wght` axes, ~450 KB) rather than several static weight files — Flutter
maps `TextStyle.fontWeight` onto the `wght` axis natively when the same asset is declared under
multiple `weight:` entries in `pubspec.yaml`, so one bundled file covers every weight the type
scale uses (plus basic Latin, so `en` text and numerals don't need a second font). Source:
`https://github.com/google/fonts/tree/main/ofl/notosansbengali` (SIL OFL 1.1,
`assets/fonts/OFL.txt`).

## Verification environment note

The installed Flutter SDK on this machine (`C:\flutter`, Windows-side) can't run against this
project's WSL path directly — its `.bat`/shell wrappers break over the WSL↔Windows bridge (a
CRLF issue for the bash wrapper; a `flutter_tools` bug walking up to an invalid UNC root for
`flutter create` specifically; and `pub run build_runner`/`flutter analyze` against the raw
`\\wsl.localhost\...` path work but are extremely slow — tens of minutes for what takes under a
minute locally, because every file read crosses the WSL↔Windows filesystem bridge). The working
approach: mirror the project onto the native Windows filesystem, run `pub get` /
`build_runner build` / `flutter analyze` / `flutter test` / `flutter build apk` there, copy the
generated `*.g.dart` and `lib/l10n/app_localizations*.dart` files back. Everything in this app
was verified that way — `flutter analyze` clean, `flutter test` passing (error-mapper parsing,
tenant/auth header injection, and the splash → picker → auth → home redirect logic), and a debug
APK build. Fixing the underlying WSL/Windows Flutter install (native Linux Flutter SDK, or a
Windows-side line-ending fix) is worth doing separately — it'll block every future Flutter task
on this machine, not just this one.

## Follow-ups (not done here)

1. Wire the real `google_sign_in` flow once the Android OAuth client + SHA-1 fingerprint exist.
2. Add `GoogleAuthRequest` to `shared-types/dart` when that lands.
3. Geolocation-based "nearby tenant" auto-detect, as an alternative/addition to the manual picker.
4. A profile screen entry point for `POST /auth/email/register` (linking a password to an
   existing session) — currently unreachable from the UI, matching "no business features yet",
   but the backend endpoint exists.
5. Fix the WSL/Windows Flutter tooling bridge (see above) so future work doesn't need the
   mirror-and-copy workaround.
