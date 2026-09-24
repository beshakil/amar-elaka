# ADR 020: Mobile auth and tenant bootstrap flows

**Status:** Accepted
**Date:** 2026-09-24
**App:** `apps/mobile`

## Context

ADR 002 shipped the client shell (splash → tenant bootstrap → auth check → home) with a manual
tenant picker, single-field OTP entry, a Google sign-in stub, and mandatory auth (guests always
bounced to `/auth/login`). This pass builds the real flows: geolocation-based bootstrap with a
district→thana fallback picker, 24h TTL + stale-while-revalidate caching, a 6-box OTP UI with
resend timer and per-error Bengali messages, real Google sign-in, guest browsing, profile
completion, and offline handling.

As with ADR 001/002, building this surfaced real backend gaps, each resolved with the user
before writing code:

- **Google and email can't create accounts.** `AuthService.googleAuth`'s own comment: "Google
  can never create an account by itself, only phone can." `POST /auth/email/register` needs an
  existing session for the same reason. **Decision:** phone+OTP is the only signup path; the UI
  reflects that directly — `LoginScreen` leads with phone, "Continue with Google" only signs in
  an _already-linked_ account (and says so in Bengali if it isn't), and email/password login is
  reached via a separate link for people who already set one. No backend change.
- **No profile-update endpoint existed** (`userProfiles.displayName`/`avatarStorageKey` had no
  way to be set after account creation). **Decision:** add `PATCH /auth/me`.
- **`GET /tenants` had no district data** (`tenants.geoAreaId` → `geo_areas` has the district as
  an ADM2 ancestor via `ancestorIds`, but nothing surfaced it). **Decision:** add
  `districtNameBn`/`districtNameEn` to `TenantSummary`.
- **No brand-color data exists anywhere** in schema or API (still true from ADR 002). Tenant
  branding here is name + logo only, same scope as before.

## Backend: `PATCH /auth/me` and district data

`PATCH /auth/me` (`update-profile.dto.ts`, `AuthService.updateProfile`) follows the same
zod-schema-as-source-of-truth pattern as every other DTO, and the same
structural-check-in-the-DTO / real-check-in-the-service split as
`email-register.dto.ts`'s password: the DTO only checks `displayName` is non-empty; the real max
length is a new platform setting (`profile_display_name_max_length`) checked in the service,
because — like `auth_password_min_length` — a display-name length cap is a tunable policy, not a
structural constant (CLAUDE.md rule 9). `avatarStorageKey`'s `.max(500)` _is_ structural (a
sanity bound on a server-generated `${tenantId}/${kind}/${uuid}` key, ~80 chars) and is marked
`settings-exempt` accordingly — the two look similar but aren't the same kind of number.

District comes from a self-join on `geo_areas` (Drizzle `alias()`): join the tenant's own area,
then join again for whichever ancestor has `adm_level = 2` (district, per ADR 003's ADM0–ADM4).
`DISTRICT_ADM_LEVEL` is `settings-exempt` — it's fixed by the HDX COD-AB numbering scheme, not a
business threshold.

## Tenant bootstrap: location → confirm → picker → ready

Four states now (`tenant_bootstrap_state.dart`) instead of two:
`NeedsLocationDecision → ConfirmNearby → NeedsSelection → Ready`. `NeedsLocationDecision` only
fires once — a `SharedPreferences` flag (`tenant_bootstrap.location_asked`) is set the moment
the user allows _or_ skips, so the rationale screen never nags on a later launch; denying just
falls through to the picker like any other "no match" case.

**24h TTL + stale-while-revalidate** (`TenantRepository.getConfig`): a cache hit within 24h is
returned with no network call at all; past 24h it's still returned immediately
(`TenantConfigResult.isStale`) while `TenantBootstrapController` kicks off a background
`fetchAndCacheConfig` and swaps in the fresh result via `ref.invalidateSelf()` once it lands,
silently, on success — failure just leaves the stale cache serving. No cache at all is the only
case that blocks. This is why `TenantBootstrapReady` carries `isStale` now, not just `TenantConfig`.

**Tenant picker** groups by district (`tenant_grouping.dart`'s `groupByDistrict`, a pure
function — no widget needed to test the sort/group logic) now that `TenantSummary` carries it.
Search still matches thana _and_ district names.

**Tenant switcher**: `AppShell` grew a shared `AppBar` (title follows the active tab, tenant
name + switcher action on the right) instead of each of the five tab screens declaring its own
— removes duplication and gives the switcher one place to live. "Change area" clears the
persisted tenant and re-enters the flow at the picker directly (not the location rationale
again — that's for first launch, not an explicit switch).

## Guest browsing

The redirect logic (`redirect_logic.dart`) used to force every unauthenticated visit to
`/auth/login`. Now tenant resolution and auth are handled as two independent phases: phase one
gets the tenant flow to wherever it needs to be, regardless of auth state; phase two is
guest-permissive — an unauthenticated user only gets bounced _out_ of the now-finished tenant
flow (to home), never _into_ `/auth/login`. A guest who explicitly navigates to `/auth/login`
(via a button, or `requireLogin`) stays there; an authenticated user still gets bounced away
from auth/tenant-flow routes to home, same as before.

`core/routing/auth_gate.dart`'s `requireLogin(context, ref)` is the one gate every "needs an
account" action goes through: authenticated → `true`, proceed; guest → pushed to login, `false`.
Wired into `PostScreen`'s create-post action (the one real entry point that exists yet); chat
and saving have no UI at all yet, so there's nothing to wire there — same helper applies once
they exist. Returning to exactly where the user was after a gated login isn't implemented
(they land on home like any fresh session) — a deliberate, noted gap, not a silent one.

## Auth flows

**BD phone**: `features/auth/domain/bd_phone.dart` mirrors
`apps/api/src/auth/phone/phone-normalizer.ts`'s regex exactly, so client-side validation can
never disagree with the server. `BdPhoneFormatter` groups digits as typed
(`01XXX-XXXXXX`) — purely cosmetic; validation/normalization strip it back out first.

**OTP**: `OtpCodeInput` (`core/design/widgets`) is a hand-rolled 6-box input — auto-advance,
backspace-to-previous, and paste support (a multi-character `onChanged` value gets distributed
across the remaining boxes) — not a package, per "no heavy... packages." The resend cooldown
(`_resendCooldown` in `otp_verify_screen.dart`) is a local UI constant, not the backend's real
`otp_resend_cooldown_seconds` setting, which the server enforces regardless of what the button
shows; this is a countdown display, not a rate limit.

**Every failure, in Bengali**: `core/network/auth_error_messages.dart`'s `describeAuthError`
switches on `ApiException.code` against the real codes in
`apps/api/src/auth/exceptions/auth.exceptions.ts` — OTP cooldown/limits/expiry/incorrect,
account state, Google link state, email conflicts, weak password, display-name-too-long,
falling back to a generic message for anything unrecognized (a new backend code must never
crash the screen showing it). Every auth screen uses this instead of the raw (English,
backend-internal) `e.message`.

**Google sign-in**, both directions through `AuthRepository.googleAuth({required bool link})`:
`link: false` (unauthenticated, `skipAuth`) signs in with an already-linked account;
`GOOGLE_ACCOUNT_NOT_LINKED` shows the Bengali message and keeps the user on the phone flow.
`link: true` (authenticated) links Google to the current session. `google_sign_in`'s v7 API
(`GoogleSignIn.instance.initialize()` once, then `.authenticate()`) is wired for real, reading
`clientId`/`serverClientId` from `--dart-define` (`GoogleAuthConfig`) — empty until the Android
OAuth client (SHA-1-bound) and a separate _Web_ OAuth client (`serverClientId`, required for
`idToken` to come back on Android at all) exist in Google Cloud Console, per the user's decision
to wire the flow now and configure it later. `GoogleSignInService.signInAndGetIdToken()` returns
null on cancel _or_ failure — a cancelled picker isn't an error to show.

**Profile completion** (`features/profile/presentation/profile_completion_screen.dart`) is
reached after _every_ OTP verification, not just new accounts — the backend doesn't expose an
"is this a new account" signal on the login response, and pre-filling the existing name/photo
means a returning user just taps "not now" instead of the app guessing. Photo upload goes
through a new generic `core/network/media_upload_service.dart` (SHA-256 checksum via
`package:crypto`, presign → `PUT` → confirm, matching `apps/api/src/storage`'s existing flow
exactly) — built kind-generic so post media can reuse it later, not avatar-specific. The
optional "add email & password" section calls the newly-exposed
`AuthRepository.registerEmailPassword` — the only place that call happens, since it's a linking
action, not a signup screen.

## Offline handling

`core/network/connectivity_provider.dart` checks connectivity once up front before subscribing
to `connectivity_plus`'s change stream (which only fires on changes, not the current state on
first listen) — otherwise the banner would read "online" by default until the first change.
`OfflineBanner` renders from `app.dart`'s `MaterialApp.router.builder`, over every screen.

**Auth survives being offline.** `AuthController._checkExistingSession()` used to treat _any_
`/auth/me` failure as "log out" — wrong for `NetworkException`/`TimeoutException` specifically,
where the session is probably still valid, just unverifiable right now. `core/storage/me_cache.dart`
(`SharedPreferences`, not `flutter_secure_storage` — a cached `MeResult` isn't secret) keeps the
last-known identity; a network-class failure with a stored token falls back to it instead of
forcing a logout. Only a real rejection (expired/invalid token, banned account, or no cached
identity at all) does that. Tenant config already had its own cache fallback (ADR 002); this
closes the same gap on the auth side.

**Never a blank screen or raw exception**: `ErrorWidget.builder` (set once in `main.dart`, not
reassigned on every `MaterialApp` rebuild) renders `GlobalErrorFallback` — itself localized via
its own `BuildContext`, falling back to plain English only in the practically-unreachable case
where it's built with no `Localizations` ancestor at all. `FlutterError.onError` and
`PlatformDispatcher.instance.onError` log instead of crashing silently past them. This is a
safety net under the per-screen try/catch → `ErrorState`/`describeAuthError` handling already in
place everywhere.

## Follow-ups (not done here)

1. Return to exactly where a guest was after a gated login (`requireLogin` currently always
   lands on home).
2. Real Google OAuth client + SHA-1 fingerprint registration (`GoogleAuthConfig`'s two
   `--dart-define` values are still empty).
3. A real feed/save/chat feature to actually exercise `requireLogin` beyond `PostScreen`.
4. Brand colors — still no data anywhere (ADR 002's same follow-up, still open).
