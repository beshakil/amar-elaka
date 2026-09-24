# @amar-elaka/e2e

End-to-end tests for `apps/web` and `apps/admin`. Playwright drives the **production builds**
(`next start`) in a real Chromium, against a stub of the API, so no Postgres, Redis or
Meilisearch is needed.

```bash
pnpm test:e2e:apps          # from the repo root: builds both apps, then runs this suite
pnpm test:e2e               # every e2e suite, including the API's (needs the test database)
```

First time on a machine: `pnpm --filter @amar-elaka/e2e exec playwright install --with-deps chromium`.

Inside this package:

```bash
pnpm test:e2e               # assumes both apps are already built
pnpm test:e2e:ui            # Playwright UI mode, for writing and debugging tests
pnpm stub                   # just the stub API, on :4010, e.g. to run the apps against it by hand
```

## How it fits together

- **`stub-api/server.ts`** stands in for the API. Every response body is typed against the
  published OpenAPI types (`@amar-elaka/shared-types`). When the API's contract changes and
  `pnpm gen:api` regenerates them, this stub stops type-checking until it matches again, so the
  suite can't keep passing against a contract that no longer exists. `POST /__control` resets
  state, simulates an outage, or shortens token lifetimes; `GET /__stats` counts calls.
- **`playwright.config.ts`** starts the stub and both apps with the same runtime environment
  variables a deployment sets. Nothing is baked in at build time, so these are the builds a real
  deployment would run.
- **Tenant subdomains** need no setup: Chromium resolves `*.localhost` to loopback itself, and the
  custom-domain fixture (`mirpur-bazaar.test`) is mapped with a launch flag. Node does not resolve
  `*.localhost`, so tests that fetch raw HTML outside the browser use `serverResponse()`, which
  sends an explicit `Host` header to 127.0.0.1.
- Tests share the stub's state, so they run serially, and every test starts from a reset stub
  (`tests/support.ts`).
- Locators are role- and label-based (`getByRole`, `getByLabel`) in Bengali, the same way a
  screen reader finds things, so accessibility regressions surface as test failures.

Unit tests for each app's pure logic (helpers, middleware decisions, the fetch layer) live beside
the code as `*.test.ts` and run with Vitest via `pnpm test`.
