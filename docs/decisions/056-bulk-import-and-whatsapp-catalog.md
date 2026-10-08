# ADR 056: Bulk import and the WhatsApp catalog

**Status:** Accepted (2026-10-09).

**Code:**

- API, bulk import: `apps/api/src/stores/import/`
  - `StoreImportService`: template, start, progress, report;
  - `StoreImportRunner`: the worker's job;
  - `import-columns.ts`: the sheet's columns, read the same way the template writes them;
  - `image-source.ts`: fetching image URLs safely.
- API, files: `apps/api/src/common/files/` (`csv.ts`, `zip.ts`, `xlsx.ts`), our own readers and writers.
- API, catalog:
  - `apps/api/src/stores/catalog/`;
  - the order in `engagement/contact.service.ts` (`catalogOrder`);
  - the share card in `seo/og-image/` (`storeCardPng`).
- Web:
  - `apps/web/src/app/store/[slug]/catalog/` (the page, and `order/[postId]/route.ts`);
  - `apps/web/src/app/og/store/[slug]/route.ts`.
- Database: `infra/migrations/0052_store_import_and_catalog.sql`
- Tests:
  - `apps/api/test/store-import.e2e-spec.ts`, `store-catalog.e2e-spec.ts`, `rls-store-imports.db-spec.ts`;
  - `src/stores/import/store-import.spec.ts`, `src/common/files/files.spec.ts`;
  - `apps/e2e/tests/web-catalog.spec.ts`.

## Context

Sellers with a real shop have dozens or hundreds of products. Typing each one into the post form is the reason they
don't. Their customers already order on WhatsApp, so a store needs a link it can share there: products with photo,
price and an order button.

Both features had to fit the existing rules:

- posts go through the normal moderation and trust score;
- images go through the normal media pipeline;
- phone numbers leave the API only through a contact endpoint that records a lead;
- no new dependencies.

## Decision

### Bulk import: `POST /stores/:id/import`

**Who.** Anyone who may post as the store (`member_may_post_as_store`, the rule from ADR 054) may import, and the store
must be active. Importers see their own imports; the owner and managers see every import of the store.

**Template.** `GET /stores/:id/import/template?categoryId=&format=xlsx|csv` builds the template from the category's
published form:

- columns are title, description, then the category's fields in the form's order, then `ছবি ১…ছবি N`
  (N = `post_max_media`);
- headers are Bengali, and required ones are starred;
- the second row is a filled example.

The importer reads headers by the same names, ignoring stars, case and spacing, so a template that was saved and
reopened in Excel still matches.

**Cells.** Cells are read the way a person writes them:

- Bengali or Latin digits, and "৳" and commas in prices;
- choice options as the code or the Bengali or English label;
- yes/no words;
- ISO or Excel-serial dates.

A wrong cell fails its row with the column's name and what it accepts, for example:
`অবস্থা: "ভাঙা" তালিকায় নেই; লিখুন: নতুন, পুরাতন`.

**Files.** The seller uploads the sheet, and optionally a ZIP of photos, through the normal presign → PUT → confirm
flow, using a new media kind `import`:

- private bucket;
- size cap `store_import_max_file_bytes`;
- confirm checks magic bytes: `PK\x03\x04` is an XLSX or ZIP, valid UTF-8 text without NUL bytes is a CSV.

The format is decided by the sniffed bytes, never by the file name. The uploads are referenced by nothing that the
orphan sweep knows about, so they are deleted after `orphan_media_hours`. That is intended: nobody needs a seller's
sheet after its import has run, and the report is kept in `store_import_rows`.

**Images.** An image cell holds either a URL or a file name from the ZIP. Both paths end the same way:

1. magic-byte sniff;
2. stored as an `image` media asset of the importer;
3. `MediaProcessingService.process`: compression, EXIF strip, WebP variants (the same code as an app upload);
4. attached by `posts.create`.

URLs are fetched from the server, which makes them an SSRF surface:

- `http(s)` only, no credentials in the URL;
- every resolved address must be public (no loopback, private, link-local, CGNAT, multicast or ULA ranges, and
  IPv4-mapped IPv6 is judged as the IPv4 it carries);
- redirects are followed by hand, at most 3, and every hop is checked again;
- the body is read under a byte cap;
- timeout `store_import_image_fetch_timeout_ms`, retry `store_import_image_fetch_attempts` on network errors and 5xx.

**Residual risk:** the address is resolved once by the check and again by `fetch()`. A DNS-rebinding server could swap
the answer in between. The fetched bytes are still only accepted as a sniffed image, and nothing fetched is ever
returned to the caller.

**ZIP.** Our own reader:

- refuses ZIP64 and encrypted entries;
- caps the number of entries (`store_import_zip_max_entries`);
- caps the total unpacked size (`store_import_zip_max_unpacked_bytes`), checked while inflating, so a ZIP bomb stops at
  the cap.

**The job.** `POST` validates the request, inserts `store_imports` (status `queued`) and queues `run-store-import` on
the `imports` queue (with a dead-letter queue). It answers `202` with the import's view. The worker:

1. reads the sheet;
2. refuses the whole import only when it can't be read at all: unreadable file, more rows than
   `store_import_max_rows`, no title column, bad ZIP, store without a location;
3. otherwise handles each row on its own and records one `store_import_rows` row: `created`, `valid` (dry run),
   `skipped` (blank row, duplicate title in the sheet) or `failed`, with a reason code and the exact Bengali reason.

A failing row never aborts the rest. Progress (`processed/total`, counts) is on `GET /stores/:id/imports/:importId`,
and the report is `GET …/report.csv`: one line per row, Bengali, and CSV-injection safe (cells starting with
`= + - @` are prefixed with `'`).

A retried job skips rows it already recorded. Each post's idempotency key is `import-<job>-<row>`, so a crash
mid-row doesn't create the post twice.

**Dry run.** `dryRun: true` runs every check `create` would run, without writing anything:

- `PostsService.validateCreate`: text lengths, owning tenant, category fields, limits, posting as the store;
- image URLs are checked (address rules) but not downloaded;
- ZIP names are matched.

Rows come out `valid` or `failed`. No post and no media is created; the e2e test checks both.

**Moderation.** Imported posts are made by `PostsService.create` with `submit: true`, exactly like the app. The
category's moderation mode and the importer's trust score decide `live` or `pending`. There is no import-specific
path.

**Limits (a change to ADR 054).** A post made as a store is bounded by the store's catalog limit
(`store_catalog_max_<tier>`, checked on every store post since 0050), not by the person's `post_max_per_day_per_user`
/ `post_max_active_per_user`. `my_post_stats()` now counts personal posts only, and `checkLimits` skips store posts.

Without this, an import stopped at the importer's tenth post of the day, and the setting-driven row limit meant
nothing. The anti-spam guarantee comes from elsewhere:

- a store is trust-gated (`pending_review` below the gate);
- its catalog is capped by tier;
- every post is still moderated by trust score.

The trade-off: a person who owns a store can now post more per day than a person without one. That is what a store
is for.

### The WhatsApp catalog: `GET /stores/:slug/catalog`

**The page.** `/store/<slug>/catalog` on the tenant's host:

- one server-rendered page, no client JavaScript of its own;
- a two-column grid of the store's live products (`post_is_listed`, newest first, at most
  `store_catalog_page_max`), each with photo (the `card` variant, lazy after the first row), price and a
  "WhatsApp-এ অর্ডার" button.

**No phone number in the HTML, ever.**

- The catalog API returns no number, and no post description (descriptions are free text and sometimes contain one).
- Each button is a `<form method="post">` to `/store/<slug>/catalog/order/<postId>` on the web host. That route calls
  `POST /stores/:slug/catalog/order/:postId` with the visitor's session and browser id.
- The API records one `lead_events` row (source `store_catalog`, channel `whatsapp_click`, the post and the store),
  with the same dedupe, daily limit and sign-in setting as every contact reveal. It answers with the `wa.me` link.
- The web route answers `303` to it. The number exists only in that `Location` header.

A form post (not a link) means no crawler or link prefetcher creates a lead. The route also refuses a post whose
`Origin` is another site, and `robots.txt` disallows the path anyway.

The message is prefilled with the product's name and its short link: `আসসালামু আলাইকুম। "আমার এলাকা"-য় আপনার
দোকানের ক্যাটালগ থেকে "{product}" অর্ডার করতে চাই।` and the link on the next line. The store's WhatsApp number is
used, falling back to its phone. A store with neither shows the products
without buttons.

**Refusals** return the buyer to the catalog with a Bengali notice: daily limit, store not taking orders, your own
store, product gone. Sign-in-required redirects to `/login`.

**Share card.** `GET /stores/:slug/og.png` draws the store's card with the same renderer and Bengali shaping as the
listing cards: name, product count, "WhatsApp-এ অর্ডার করুন", area, cover photo. It is cached in storage by a hash of
its content. The page's `og:image` points at `/og/store/<slug>` on the tenant's own host, which proxies it, so
WhatsApp's link preview shows the card.

**Export: `GET /stores/:id/catalog.csv`** (owner and managers, `edit_settings`). Every listed product, one row each.

### The export format: what we assume, and what we're unsure of

**Assumption.** The WhatsApp Business **app** has no CSV import: products are added one by one in the app. Bulk
catalogs for WhatsApp are made in **Meta Commerce Manager**, whose catalog is what WhatsApp Business shows. So we
export Commerce Manager's data-feed CSV:

| column         | value                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------- |
| `id`           | the post id (stable, so a re-upload updates instead of duplicating)                         |
| `title`        | the post title                                                                              |
| `description`  | the post description, or the title when there is none (the column is required)              |
| `availability` | `in stock`                                                                                  |
| `condition`    | `new` / `used` / `refurbished`, mapped from the post's `condition` field; `new` when absent |
| `price`        | `"<amount> BDT"`, for example `3200.00 BDT`                                                 |
| `link`         | the product's public short link                                                             |
| `image_link`   | the full-size WebP of the first photo                                                       |
| `brand`        | the store's name                                                                            |

The file is UTF-8 with a BOM, CRLF line ends, and RFC 4180 quoting.

**What we are not sure of:**

- **WebP images.** Commerce Manager documents JPEG and PNG for `image_link`. We serve WebP, and we have not verified
  that the importer accepts it. If it doesn't, the export needs a JPEG variant.
- **Required columns and price format.** The required set and the `"<amount> <ISO currency>"` price format are from
  Meta's published feed specification as we understand it. We have not run an upload against a real Commerce Manager
  account.
- **Descriptions with phone numbers (open question).** A description may contain a number the seller typed into it.
  The export is the seller's own text, downloaded by the store's owner or a manager for the store's own catalog. It
  carries no number from any other field. We export descriptions as written, without guessing at and stripping digits.
  If "never in exports" is meant to cover this case too, the export should drop descriptions; that is a one-line
  change.
- **WhatsApp Business API catalogs.** We assume they use the same Commerce Manager catalog. We have not checked them
  separately.

Before telling sellers "upload this to WhatsApp", someone should do one real upload and adjust.

### API

| Endpoint                                       | Who                             | Notes                                                         |
| ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| `GET /stores/:id/import/template`              | store posters                   | `categoryId`, `format=xlsx\|csv`                              |
| `POST /stores/:id/import`                      | store posters                   | `categoryId`, `sheetMediaId`, `imagesMediaId?`, `dryRun`; 202 |
| `GET /stores/:id/imports`                      | own; owner and managers see all | the 20 most recent                                            |
| `GET /stores/:id/imports/:importId`            | as above                        | progress and every row                                        |
| `GET /stores/:id/imports/:importId/report.csv` | as above                        | the downloadable report                                       |
| `GET /stores/:slug/catalog`                    | public (host tenant)            | no phone number                                               |
| `POST /stores/:slug/catalog/order/:postId`     | public; sign-in per setting     | the lead, then the `wa.me` link                               |
| `GET /stores/:slug/og.png`                     | public                          | the share card                                                |
| `GET /stores/:id/catalog.csv`                  | owner, managers                 | Commerce Manager feed                                         |

### Settings

All are new:

| Setting                               | Default |
| ------------------------------------- | ------- |
| `store_import_max_rows`               | 500     |
| `store_import_max_file_bytes`         | 20 MB   |
| `store_import_zip_max_entries`        | 1000    |
| `store_import_zip_max_unpacked_bytes` | 500 MB  |
| `store_import_image_fetch_timeout_ms` | 10 000  |
| `store_import_image_fetch_attempts`   | 2       |
| `store_catalog_page_max`              | 200     |

## Alternatives considered

- **A spreadsheet library (SheetJS, ExcelJS) and an unzip library.** Rejected: no new dependencies. The subset we
  need is small: the first sheet's cells (shared and inline strings, numbers, booleans), and a ZIP's stored or deflated
  entries. Node 24's `zlib` covers it, with `inflateRawSync` limited by `maxOutputLength` and `crc32`.
  - The reader is tested against a file written by openpyxl.
  - For formulas it reads the cached value. It ignores styles and every sheet but the first.
  - If sellers bring files we can't read (for example, strict OOXML), switching to a library is a contained change.
- **Importing synchronously.** Rejected: a few hundred rows with image downloads takes minutes.
- **A GET link for "order".** Rejected: prefetchers and crawlers would create leads, and a GET with side effects
  invites them.
- **Putting the number in the page behind a "show" button.** Rejected: it's in the HTML (rule).

## Consequences

- Sellers can fill a store from a sheet in one go, with a report that says exactly what to fix, and can try it first
  with a dry run.
- A store has a shareable catalog link that previews well in WhatsApp. Every order tap is a lead, so it appears in the
  seller analytics (ADR 055) as a WhatsApp contact.
- Store posts no longer count toward the person's daily and active limits (see Limits). Revisit if store spam
  appears.
- The CSV export's fit with Commerce Manager is an assumption until a real upload confirms it.
- Our XLSX/ZIP readers are ours to maintain. They are small and tested, but not as complete as a library.
