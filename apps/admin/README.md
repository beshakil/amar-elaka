# @amar-elaka/admin

The operator dashboard: one deployment serving both tenant admins and platform
staff, with the navigation and the pages they can reach decided by their
permissions.

## Running locally

```bash
cp apps/admin/.env.example apps/admin/.env.local
pnpm --filter @amar-elaka/api dev        # the API must be up
pnpm --filter @amar-elaka/admin dev      # http://localhost:3002
```

Sign in with an account that has an email and password
(`POST /auth/email/register` links them to an existing account) and pick the
area it belongs to. `pnpm --filter @amar-elaka/api db:seed` creates the tenants.

## How auth works here

The API speaks bearer tokens only. This app never lets the browser hold one:

1. The login form posts credentials to `src/app/api/auth/login/route.ts`.
2. That handler calls the API and writes the access and refresh tokens into
   **httpOnly** cookies.
3. `src/middleware.ts` gates every dashboard route on the access token, and
   rotates it through `/auth/refresh` when it has expired, so a 15-minute token
   does not mean a 15-minute session.
4. Server Components read the cookies and forward the token as an
   `Authorization` header. Nothing calls the API from the browser, which is also
   why the API needs no CORS configuration.

Because a token is scoped to one tenant, the tenant is chosen at login and
platform staff switch tenant by logging into another.

## What each part is for

- `src/components/data-table/` — the generic table every module reuses: sorting,
  filtering, pagination, bulk selection, column visibility, CSV export. Built on
  TanStack Table v9; build columns with `dataTableColumnHelper()`.
- `src/components/crud/crud-page.tsx` — list + create + edit + delete for one
  entity. Every mutating slot is optional, so a module only shows the actions
  its API actually supports.
- `src/components/form/zod-form.tsx` — react-hook-form bound to a zod schema, so
  the client enforces the same shape the API's own zod DTO does.
- `src/lib/nav/nav.ts` — the two navigation sets and the grant each item needs.
- `src/app/(dashboard)/roles/` — the first module built on all of the above.

## Conventions

- No user-facing string in a component: they live in `src/messages/bn.json`.
- Every call to the API goes through `src/lib/api/fetch.ts` — timeout, retry for
  GETs, typed errors, zod-checked responses.
- Permission checks live on the server. Gate a module in its segment's
  `layout.tsx` with `requireGrant()` / `requirePlatformAdmin()`
  (`src/lib/auth/guards.ts`), next to its own `loading.tsx`. The layout renders
  above the loading boundary, so a denial is a real 404. Hiding a nav item is a
  convenience, not the check.
- Server Actions return an `ActionResult` instead of throwing: errors thrown
  across the action boundary lose their class and message in production.
