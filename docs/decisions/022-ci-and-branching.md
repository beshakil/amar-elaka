# ADR 022: CI and branching

**Status:** Accepted
**Date:** 2026-09-24
**Files:** `.github/workflows/ci.yml`, `.github/pull_request_template.md`, `.github/dependabot.yml`, `.nvmrc`

## Context

Until now the repo had no CI. Every check already existed as a command (`pnpm lint`,
`typecheck`, `test`, `build`, the Playwright suite, `apps/api`'s database suites, the Flutter
analyze/test cycle), but nothing ran them on a push or a pull request. So nothing stopped a
change from landing that broke a migration, an RLS policy or a build.

## Decisions

### 1. One workflow, path-filtered per job

`ci.yml` runs on pushes to `main`, on every pull request, and on demand. Jobs:

| Job           | Runs when                                                   | What it does                                                                                             |
| ------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `changes`     | always                                                      | Works out which areas changed (`dorny/paths-filter`).                                                    |
| `quality`     | Node code changed (`apps/{api,web,admin,e2e}`, `packages/`) | `pnpm lint`, `pnpm typecheck`, `pnpm test`, and a check that `openapi.json` matches the API code.        |
| `integration` | API, `infra/` or `packages/config` changed                  | PostGIS service container; applies every migration from scratch, then runs every RLS and database suite. |
| `build`       | Node code changed                                           | `pnpm build` (API, web, admin), then the Playwright suite against those production builds.               |
| `mobile`      | `apps/mobile` or `packages/shared-types/dart` changed       | Regenerates code, then `dart format` check, `flutter analyze`, `flutter test`.                           |
| `ci-ok`       | always                                                      | Passes only if every job above passed or was skipped.                                                    |

Editing `ci.yml` itself runs everything.

Filtering happens **per job, not with a workflow-level `paths:`**. A workflow that never starts
never reports its checks. If one of those checks is required, the PR waits on it forever. A
job skipped by its `if:` does report, and a skipped job counts as passing.

### 2. `CI OK` is the only required check

Branch protection requires one check, **`CI OK`**. That job depends on all the others and
fails if any of them failed or was cancelled. Adding, renaming or splitting jobs never needs a
branch-protection change, and a docs-only PR (every real job skipped) can still merge.

### 3. What the jobs guarantee

- **Migrations and RLS.** The job needs no scripting of its own. It runs
  `infra/db/bootstrap-roles.sql` (what `make db-roles-test` does), then `test:db`. `test:db`'s
  global setup drops the test schema and applies every migration in real deploy order: 0000–0002
  as the superuser, the rest as `ae_migrator` (ADR 019). Then it runs every `*.db-spec.ts`: the
  `rls-*` cross-tenant suites, `migrations`, `schema-drift`, `schema-audit`. The database uses
  the same `postgis/postgis:16-3.4` image as `infra/docker-compose.dev.yml`. Its passwords are
  throwaway values in the workflow, because the database exists only for the length of the job.
- **The API contract.** `quality` runs `pnpm gen:api` and fails if the committed
  `packages/shared-types/openapi.json` changes. Both apps and the e2e stub type-check against
  that file (ADR 021), so it must never lag the API.
- **Builds need no runtime config.** `pnpm build` runs with no environment variables at all. The
  web and admin apps validate their env on first use (`env()`), not at import, because
  `next build` imports route modules and one image is deployed with different configuration.
  This was a real bug: the builds only passed locally because `.env.local` existed.
- **The browser suite runs on every relevant PR.** It reuses the job's fresh production builds.
  Chromium is cached by Playwright version, and on failure the HTML report and traces are
  uploaded as the `playwright-report` artifact.
- **Mobile.** Generated code (`*.g.dart`, l10n output) is gitignored, so the job regenerates it
  in `packages/shared-types/dart` and `apps/mobile` exactly as a developer would. The format
  check covers tracked files only.

### 4. Toolchain pins

- **Node** comes from `.nvmrc` (24, the active LTS and what local development uses). The
  `engines` floor stays `>=20`.
- **pnpm** comes from `packageManager` in `package.json`, read by `pnpm/action-setup`.
- **Flutter** is pinned in `ci.yml` (`3.44.0`, matching `apps/mobile/pubspec.lock`). Dependabot
  does not manage it: bump it deliberately, together with the Flutter SDK used locally.

### 5. Branching model

- `main` is always releasable and only changes through pull requests.
- Short-lived branches, named `<type>/<short-description>` (`feat/roles-edit`,
  `fix/sitemap-origin`), using the same types as conventional commits (`feat`, `fix`, `chore`,
  `refactor`, `test`, `docs`, `ci`).
- **Squash merge.** The PR title becomes the commit on `main`, so it follows conventional
  commits.
- The PR template's checklist covers what CI can't see: whether tests were _added_, whether a
  migration was _reviewed_, whether new tenant-scoped tables have RLS _and_ a cross-tenant test
  (CLAUDE.md rule 7).

### 6. Branch protection for `main`

Set in **Settings → Branches → Add branch protection rule** (or an equivalent ruleset) for
`main`:

- Require a pull request before merging.
  - Required approvals: **0 while this is a one-person project.** GitHub won't let the author
    approve their own PR, so 1 would block every merge. Raise it to **1** (and enable "Dismiss
    stale pull request approvals when new commits are pushed") as soon as a second contributor
    joins.
- Require status checks to pass: **`CI OK`**, with "Require branches to be up to date before
  merging".
- Require conversation resolution before merging.
- Require linear history (with squash-only merges enabled under Settings → General).
- Do not allow force pushes or deletions.
- Do not allow bypassing the above settings, including for administrators.

The same rule, applied with the GitHub CLI by someone with admin rights on the repository:

```bash
gh api -X PUT repos/beshakil/amar-elaka/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "CI OK" }] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

`CI OK` has to have run at least once (push the workflow first) before GitHub offers it as a
required check in the settings UI.

### 7. Turborepo remote cache: wired, off until enabled

The workflow already passes `TURBO_TOKEN` (secret) and `TURBO_TEAM` (variable) to every job.
While they are empty, Turborepo uses its local cache, which `actions/cache` saves and restores
per job (`.turbo/cache`). Enabling Vercel's remote cache needs only repository settings.
Self-hosting needs one extra line in the workflow (not added yet, because an empty `TURBO_API`
would be read as a broken URL rather than as "unset"):

- **Vercel Remote Cache.** Run `npx turbo login` then `npx turbo link` locally. Create a token
  under Vercel → Account Settings → Tokens. Then in GitHub → Settings → Secrets and variables →
  Actions, add the secret **`TURBO_TOKEN`** and the variable **`TURBO_TEAM`** (the team slug).
- **Self-hosted** (e.g. `ducktors/turborepo-remote-cache` on the Contabo VPS). Deploy it, then
  set the same two values, plus a **`TURBO_API`** variable with the cache server's URL, and add
  `TURBO_API: ${{ vars.TURBO_API }}` to the workflow's top-level `env:`.
- **Either way, sign artifacts.** Add `"remoteCache": { "signature": true }` to `turbo.json` and
  a **`TURBO_REMOTE_CACHE_SIGNATURE_KEY`** secret (also exposed in `env:`), so a poisoned cache
  entry is rejected instead of replayed into a build.

Local development can share the same cache with `npx turbo login && npx turbo link`.

### 8. Dependabot

`.github/dependabot.yml` runs weekly, on Mondays, Dhaka time:

- **npm**, for the whole pnpm workspace. Minor and patch updates come grouped in one PR; majors
  come one per PR.
- **GitHub Actions**, grouped.
- **pub**, for `apps/mobile` and `packages/shared-types/dart`.

Deliberate pins are excluded from major updates, each with its reason in the file: Next.js 15
(ADR 021), zod 3 (shared by the API DTOs and the apps' schemas), and Vitest 4 (5 needs Node ≥
22.12). Dependabot PRs go through the same CI as any other.

### 9. Found while verifying from a clean checkout

Running each job's commands against only the files git would commit, rather than the working
tree, turned up two bugs that had been invisible locally:

- **The root `.gitignore` had a bare `storage/` rule** (meant for the Docker volume and
  `STORAGE_LOCAL_PATH=./storage/uploads`). It matched _every_ directory called `storage`, so git
  silently ignored `apps/api/src/storage/` (the API's whole storage module, 10 files) and
  `apps/mobile/lib/core/storage/` (the app's database, session storage and caches, 8 files).
  Neither the API nor the app would have compiled from a clone. The rule is now anchored to
  `/storage/` and `/apps/api/storage/`.
- **The Next.js builds required runtime env** (decision 3).

After the fixes, every job's sequence passes from a clean copy, except `integration`, which needs
Postgres and was checked with `actionlint` only.

## Not covered yet

- **Formatting.** `pnpm format:check` fails on about 130 files that predate the Prettier setup.
  One commit that only reformats, then a `pnpm format:check` step in `quality`, closes this.
- **The API's Jest e2e specs** (`apps/api/test/*.e2e-spec.ts`, including the RBAC role
  edit/delete cases). They boot the whole app, so they need Redis, Meilisearch and MinIO service
  containers as well as Postgres.
- **Deploys.** CI proves a change is safe to merge. Shipping it to Coolify is separate.
