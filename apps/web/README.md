# @amar-elaka/web

The public, tenant-facing site. One deployment serves every tenant; which one a
request belongs to is decided by its hostname.

## Running locally

```bash
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @amar-elaka/api dev     # the API must be up: the site resolves tenants through it
pnpm --filter @amar-elaka/web dev     # http://localhost:3001
```

## Testing wildcard subdomains without touching /etc/hosts

`middleware.ts` reads the request's `Host`, asks the API which tenant it belongs
to (`GET /tenants/resolve?host=…`), and forwards the answer downstream as
`x-tenant-id`. To exercise that locally you need a real subdomain in the URL bar
— and every current browser and OS already resolves **any** `*.localhost` name
to the loopback address, so nothing needs to be registered:

| URL                            | What it exercises                                      |
| ------------------------------ | ------------------------------------------------------ |
| `http://mirpur.localhost:3001` | the `mirpur` tenant, if a tenant with that slug exists |
| `http://nope.localhost:3001`   | the "no coverage at this address" page                 |
| `http://localhost:3001`        | no subdomain, so also the no-coverage page             |

Use whichever slugs your database actually has (`pnpm --filter @amar-elaka/api db:seed`
creates them). `APP_ROOT_DOMAIN=localhost` in `.env.local` is what makes the API
read the first label as a tenant slug; in production it is the real base domain
and a tenant's own custom domain resolves through the same endpoint.

Safari is the exception — it does not resolve `*.localhost`. Add the hosts you
need to `/etc/hosts` (`127.0.0.1 mirpur.localhost`) or test in another browser.

## Conventions

- Every call to the API goes through `src/lib/api/fetch.ts` — timeout, one retry
  for GETs, typed errors, and a zod check on the response shape.
- No user-facing string lives in a component: they are all in
  `src/messages/bn.json` and read through next-intl.
- Dark mode and tenant branding are applied on the server (a cookie and the
  tenant config), so neither flashes on first paint.
