# ADR 021: The two Next.js apps — tenant resolution, auth and the admin abstractions

**Status:** Accepted
**Date:** 2026-09-24
**Apps:** `apps/web`, `apps/admin`

## Context

Week 3's remaining client-shell work: a public, tenant-facing site and an operator dashboard,
both Next.js 15 (App Router, Tailwind v4, TypeScript strict via `@amar-elaka/config`). No
business features — what these apps needed was the infrastructure everything later sits on:
deciding which tenant a request belongs to, theming and i18n that do not flash or hardcode
copy, an auth model for a backend that only speaks bearer tokens, and the generic
table/CRUD/form pieces every admin module will reuse.

As with ADR 001/002/020, building this surfaced things the API could not do yet.

## Decisions

### 1. `GET /tenants/resolve?host=` — resolving a hostname from outside the API

`TenantResolutionMiddleware` resolves a tenant from `X-Tenant-Id` or, failing that, from the
request's own `Host` (subdomain under `APP_ROOT_DOMAIN`, else custom domain). That works inside
the API's pipeline and nowhere else: `apps/web` is a separate server, so the fetch it makes to
the API carries the API's hostname, not the browser's. It therefore has to resolve the browser's
hostname itself and forward the answer as `X-Tenant-Id`, and it had no way to do that —
`GET /tenants` returns no `customDomain`, and matching slugs against it would reimplement the
middleware's own precedence in a second place.

Added `GET /tenants/resolve?host=` (`@AllowAnyTenant()`), which reuses
`TenantLookupService.resolveBySlug`/`resolveByCustomDomain`. The hostname-reading itself moved
into a pure `tenantSignalFromHostname()` (`apps/api/src/database/hostname-tenant-signal.ts`) that
both the middleware and the new endpoint call, so there is one definition of what a hostname
means. An unknown host answers `{ tenantId: null }` with a 200: it is a legitimate outcome, not
an error, and an object is easier to describe in OpenAPI and branch on than a bare `null`.

### 2. Both apps call the API server-side only

There is no CORS configuration in `apps/api`, and this keeps it that way. Every call happens in a
Server Component, Server Action or Route Handler; nothing in the browser talks to the API
directly. That also means no access token is ever reachable from client JavaScript.

The trade-off is that interactive data fetching costs a round trip through the Next server. At
this scale that is the right side of the trade: it removes a whole class of token-handling and
CORS problems, and every list these apps serve today is small.

### 3. Admin auth is a cookie BFF over the bearer API

The API issues `{ accessToken, refreshToken }` and has no cookie support; refresh tokens are
single-use and rotate, with family revocation on reuse. So `apps/admin` owns a thin BFF:
`/api/auth/login` and `/api/auth/logout` exchange credentials with the API and write both tokens
into **httpOnly** cookies, and `src/middleware.ts` gates dashboard routes on the access token,
rotating it in place when it has expired rather than bouncing a working session to the login
screen every fifteen minutes.

A token is scoped to one tenant, so **the tenant is chosen at login** — the login form lists
tenants from the public `GET /tenants` and sends the choice as `X-Tenant-Id`. Platform staff
switch tenant by signing in against another one; a single session cannot span tenants because a
token cannot.

Verified end to end: an expired access token is rotated in middleware and the same request's
Server Components already see the new token (Next applies cookies set on the middleware
response to the downstream request). Replaying the spent refresh token ends the session.

Known limitation: two requests arriving together with an expired access token can both attempt a
rotation, and single-use refresh tokens mean the loser's token is already spent. The matcher
excludes static assets so this is rare, and the failure mode is a redirect to `/login`, not a
corrupted session. A single-flight refresh (the mobile app's `QueuedInterceptor` equivalent) is
the fix if it ever shows up in practice.

### 4. Response types: published by the API, checked at runtime by the apps

Originally the OpenAPI document typed request bodies but described every response as `{}`,
so each app declared its own zod response schemas with nothing tying them to the API. That
gap is closed (ADR 001's amendment): the API publishes every response the apps consume,
inferred from one zod schema per shape, and `pnpm gen:api` captures it offline.

The apps keep their zod schemas, because a runtime check at the boundary is still worth
having: a malformed response becomes a typed `ApiShapeError` rather than an `undefined` three
components later. What changed is that each schema is now **tied to the generated type** by a
compile-time assertion at the bottom of `src/lib/api/schemas.ts`: the API's published type
must be assignable to the type the app parses. An app may read fewer fields than the API
sends, but not a field the API doesn't send, and not a field with the wrong type or
nullability. After an API change and `pnpm gen:api`, drift fails `pnpm typecheck` instead of
failing at runtime. (Verified with deliberately wrong probes: a type change and a nullability
change both fail.)

### 5. No flash, because the server already knows

Dark mode is a cookie read with `cookies()` in the root layout and applied as `data-theme` on
`<html>`; tenant branding is fetched server-side and applied as CSS custom properties in the same
render. Both are correct in the first byte of HTML, so neither needs the blocking inline script a
static site would use. `prefers-color-scheme` still decides when the preference is `system`.

Tenant _colours_ remain unavailable — `branding` carries only `logoStorageKey`, the same gap ADR
002 logged. `tenantThemeVars()` is the single place that changes when the column lands.

### 6. Bengali only, no locale routing yet

next-intl wraps both apps with one `bn.json` catalog and no `[locale]` segment. Rule 6 is about
strings not being hardcoded, which the catalog satisfies; a locale-prefixed route tree for every
placeholder page would be scaffolding for a switcher nobody asked for. Adding `en.json` plus
routing later is additive.

### 7. No shared `packages/ui`

shadcn/ui's model is components copied into an app and edited there, and there is exactly one
consumer of the dashboard shell and one of the public-site theming. A shared package now would be
an abstraction with a single caller. The small overlap that does exist (`cn`, `Button`, `Input`,
`Skeleton`, the API error classes) is duplicated deliberately. Revisit when a third consumer
appears.

### 8. TanStack Table v9 for the DataTable

v9 rather than the v8 API most examples show: features are registered explicitly
(`tableFeatures({...})`), state lives in a store, and `table.state` replaces `getState()`. It is
the current major and this component is meant to outlive several modules.

`CrudPage`'s mutating slots are all optional, so an entity only gets the affordances its API
serves and the viewer is allowed; no button is rendered for an endpoint that doesn't exist.
Roles now uses all of them (decision 13). The Tenants page is a plain `DataTable`, since the API
has no tenant create/update endpoint.

### 9. "No tenant here" and "could not ask" are different answers

The middleware forwards `x-tenant-resolution: resolved | none | unavailable` alongside
`x-tenant-id` (both stripped from the incoming request first, so a client cannot supply
them). `none` renders the no-coverage page. `unavailable` (API down, timeout, 5xx) throws into
the route's error boundary with a retry, because telling a visitor their area doesn't exist
when the API blipped would be wrong. The header, footer and metadata use
`tenantConfigForChrome()`, which never throws, so the site chrome still renders around the
error. A tenant already served keeps rendering from Next's data cache while the API is down.

Resolutions are cached in the middleware for a minute, bounded to 1,000 hostnames because
`Host` is client-controlled. Only definite answers are cached, never `unavailable`.

### 10. SEO URLs name the tenant's own host

Canonical URLs, `metadataBase`, sitemap entries, `robots.txt`'s sitemap line and JSON-LD all
use `currentOrigin()`: the request's host with the configured scheme. With the single
platform `SITE_ORIGIN`, every tenant would declare the same canonical site and search engines
would fold them together. The host can be trusted here because only a hostname the API
resolved to a tenant reaches a page that uses it. The middleware now runs for `sitemap.xml`
too; it had been excluded, which made every tenant's sitemap empty.

### 11. Dashboard permission gates live in segment layouts

`requireGrant()` / `requirePlatformAdmin()` (`src/lib/auth/guards.ts`) are called from a
segment's `layout.tsx`, which renders **above** that segment's `loading.tsx`. Called from the
page, inside the loading boundary, a denial came back as a streamed **200**, because the
shell had already been sent. From the layout it's a real 404. The page calls the same gate
before fetching, so a denied viewer never costs an API round trip. `(dashboard)/not-found.tsx`
keeps the 404 inside the dashboard shell. Next sends a thrown `notFound()` as a 404 whose UI
is in the RSC payload and renders on hydration (React can't server-render an error boundary's
fallback), which is fine for a dashboard that requires JS. Nothing gated appears anywhere in
the response.

### 12. Server Actions return failures instead of throwing them

An error thrown across the Server Action boundary reaches the browser stripped of its class
and message in production, so the client could never tell a duplicate name from a lost
connection. Actions return `ActionResult` (`{ ok: true } | { ok: false; messageKey }`), with
the Bengali message key resolved on the server where the typed error still exists. Actions
also validate their own arguments with zod (a role id is a uuid before it's put in a path),
because they're callable endpoints in their own right.

### 13. Roles: full CRUD, built-ins immutable

The API gained `PATCH /roles/:roleId` (rename and/or replace the matrix) and
`DELETE /roles/:roleId` (members fall back to their built-in `role_code`, via
`custom_role_id ... ON DELETE SET NULL`). Built-in roles are templates every tenant shares
(`tenant_id NULL`) and are refused with `ROLE_BUILTIN_IMMUTABLE`. The write is also scoped to
`tenant_id`, so a built-in couldn't be touched even without the explicit check. A matrix
change or delete invalidates the tenant's permission cache, so holders see it on their next
request. Renaming never changes the role's `code`. In the dashboard, `CrudPage` gained
per-row `canEdit`/`canDelete` (built-ins show neither) and bulk delete. Each affordance
appears only if the viewer holds the matching grant.

### 14. Testing: Vitest for logic, Playwright for behaviour

- **Unit (Vitest, `pnpm test`):** each app's pure logic, beside the code as `*.test.ts`: the
  tenant middleware (all three resolution outcomes, header stripping, the bounded cache), the
  admin middleware (gating, rotation, refused vs. unavailable), the fetch layer (timeout,
  GET-only retry, typed errors, shape checks), breadcrumbs, CSV escaping including formula
  injection, grant matching, and that every error code maps to a key that exists in the Bengali
  catalog. Vitest 4 rather than 5: 5 needs Node ≥ 22.12, and the repo declares `>= 20`.
- **End to end (Playwright, `apps/e2e`, `pnpm test:e2e:apps`):** the production builds in
  Chromium against a stub API that is **typed against the published OpenAPI types**, so it
  can't drift from the real contract. Locators are role- and label-based, in Bengali, so
  accessibility regressions fail tests. 42 tests, stable across repeated runs.

The suite paid for itself before it landed. It found a Retry button that did nothing (it
called `reset()` without `router.refresh()`, so the failed Server Component was never
re-fetched), counts rendered with Latin digits in a Bengali UI (messages now use
`{count, number}` so the locale decides), a CSV export with an empty column for the row
actions, a middleware that logged operators out when the API blipped during token renewal
(rotation is now three-way: rotated / refused / unavailable, and only a refusal ends the
session), and a permission picker whose checkboxes had no group label for assistive tech.

## Consequences

- One deployment per app serves every tenant; adding a tenant needs no deploy, only DNS for its
  subdomain.
- `apps/web` degrades to a "no coverage at this address" page when a hostname resolves to
  nothing, and to its error boundary when the API is unreachable — never a blank page.
- The admin app's permission model is `GET /me/permissions` (`isPlatformAdmin` picks the nav set,
  `grants` filter within it). Nav filtering is convenience; each page re-checks server-side.
- Local subdomain testing needs no `/etc/hosts`: `*.localhost` already resolves to loopback
  (`apps/web/README.md`). Safari is the exception.

## Open items

- Brand colours in the tenant schema (decision 5, carried from ADR 002).
- Single-flight refresh in the admin middleware if concurrent-rotation logouts appear
  (decision 3).
- CI: there is no pipeline yet. `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e:apps`
  needs no infrastructure (plus `playwright install --with-deps chromium` once); the API's
  `test:e2e`/`test:db` need the test database.
- Run the RBAC e2e cases (`apps/api/test/rbac.e2e-spec.ts`, "editing and deleting custom
  roles") against a real database.
