# ADR 039 — Public listing pages and SEO

**Status:** Accepted (2026-09-28). Code: `apps/web/src/app/{page.tsx,category,listing,store,gone,og,sitemap.xml,sitemaps,robots.ts}`,
`apps/web/src/lib/{listings,seo}`, `apps/web/src/components/listings`, `apps/web/src/middleware.ts` (the gate);
`apps/api/src/seo` (status, sitemap and store endpoints, the share image); migration `0033_public_listing_seo.sql`.
Builds on ADR 035 (feed), 036 (detail, contacts), 037 (saved).

Search is the main way a new visitor finds a listing, so these pages are built for crawlers first: the right status
code, Bengali titles, one canonical URL per page, structured data, and a sitemap per tenant.

## Decisions

**1. Pages.**

| Page                   | Shows                                                                   | Structured data               |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| `/`                    | categories, recent listings, today's bazar prices, the emergency number | WebSite, Organization         |
| `/category/[slug]`     | a grid, newest first within the area's radius; filters; numbered pages  | ItemList, BreadcrumbList      |
| `/listing/[id]/[slug]` | gallery, price, fields, description, seller, contact, similar           | Product + Offer, Breadcrumb   |
| `/store/[slug]`        | name, address, verified, followers, the store's listings (basic)        | LocalBusiness, BreadcrumbList |

- **Rendering:** all four are server-rendered HTML.
- **Filters:** a plain GET form (`f.<field>.<op>`), so a filtered view works without JavaScript.
- **Filtered views:** `noindex`, canonical to the unfiltered category.
- **Page 2+:** its own canonical URL (`?page=2`), with `rel="prev"`/`rel="next"` links.

**2. "ISR" is Next's data cache, per tenant.**

- **Why not route ISR:** the tenant comes from the Host header, so a page can't be prerendered once for everyone.
- **What is cached instead:** each page's API reads, for a window the tenant config gives, all settings:
  - `web_home_revalidate_seconds` (300);
  - `web_category_revalidate_seconds` (300);
  - `web_listing_revalidate_seconds` (600; listing and store pages).
- **Why it is safe:** every read is anonymous, so a cached response is the same for every visitor.
- **Cost:** a render is a few cached reads.
- **Metadata:** `htmlLimitedBots: /.*/` makes metadata block and render in `<head>` for every client, never streamed
  after it.

**3. The canonical URL is `/listing/<id>/<bengali-slug>`.**

- **The slug (`listingSlug`):**
  - NFC-normalised;
  - letters, marks and digits kept, so conjuncts (ক্ষ, স্ব) survive;
  - zero-width joiners dropped;
  - everything else becomes a hyphen;
  - at most 80 characters, cut at a word boundary;
  - percent-encoded in the path.
- **Redirects (middleware, 308):**
  - `/listing/<id>` or a stale slug → the canonical URL;
  - another tenant's listing → the same path on that tenant's host.
- **Redirect host:** redirects are built from `SITE_ORIGIN`'s scheme and the Host header. Behind the proxy,
  `request.url` carries the server's internal address.

**4. Status codes are decided before rendering.**

- **Why middleware:** the root `loading.tsx` streams, so once a page starts rendering it can only answer 200 (a soft
  404).
- **How:** the middleware asks `GET /seo/listing-status/:id`, backed by the SECURITY DEFINER `post_public_status`. It
  sees rows the public can't, but returns a title only for live or sold posts.

| State                                    | Answer                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| live                                     | 200, indexed                                                           |
| sold                                     | 200, the page kept and marked sold, contact closed, Offer `SoldOut`    |
| sold more than `sold_noindex_days` (90)  | 200, `noindex`, left out of the sitemap                                |
| expired, removed, deleted, scrubbed      | **410 Gone** (rewrite to `/gone`, Bengali, `noindex`)                  |
| draft, pending, rejected, hidden, no row | **404**                                                                |
| legal hold                               | 404, as if the row didn't exist; the function excludes legal-hold rows |
| unknown category or store                | 404                                                                    |

- **Caching:** answers are cached in the middleware for 60 s.
- **API down:** if the API can't answer, the page renders its own error state rather than a wrong 404.

**5. Titles and descriptions come from Bengali templates** (`messages/bn.json` → `seo`):

- Listing: `{title} — {price} টাকা | {area}, {tenant}`, plus " (বিক্রি হয়ে গেছে)" when sold.
- Category: `{category} — {tenant}-এর বিজ্ঞাপন | আমার এলাকা`, with `পাতা {n}` from page 2 on.
- Store: `{store} — {area}, {tenant} | আমার এলাকা`.
- Home: `{tenant}-এ কেনাবেচা, ভাড়া ও স্থানীয় তথ্য | আমার এলাকা`.

**6. Share images are rendered by the API with sharp, not by `next/og`.**

- **Why not Satori (`next/og`):** it can't shape Bengali. Conjuncts and vowel signs come out broken.
- **How:** libvips' text renderer (Pango + HarfBuzz) with the bundled Noto Sans Bengali shapes them correctly.
- **What the image shows:** 1200×630 with:
  - the cover photo;
  - the title (60 → 50 → 42 px, never scaled up);
  - the price in Bengali digits;
  - the area and the tenant's brand;
  - a "sold" pill when sold.
- **Storage:** `og/<post>/<hash of what it shows>.png`, so each version renders once and every later request is a
  storage read.
- **URL:** the web serves it at `/og/listing/<id>?v=<updatedAt>` on the tenant's own host (a proxy with timeout and one
  retry).

**7. Sitemaps are per tenant and split.**

- **The index:** `/sitemap.xml` lists:
  - `/sitemaps/pages.xml` (home, info, map, categories);
  - `/sitemaps/listings-<n>.xml` (live listings, plus sold ones still indexed);
  - `/sitemaps/stores-<n>.xml`.
- **File size:** each file holds at most `sitemap_urls_per_file` (10,000) URLs. The index and every file take that
  number from the same `/seo/sitemap/summary`, so they always agree.
- **robots.txt:** allows listings and stores; disallows `/api/`, `/me/`, `/post/`, `/login` and `/gone`.

**8. Contact on the web works as on mobile, and the number is never in the HTML.**

- **Page HTML:** the detail the page renders has no phone (ADR 036); the store page has none either.
- **"নম্বর দেখুন" (show number):** calls this site's `POST /api/posts/:id/contact`, which calls the API's
  `POST /posts/:id/contact` with:
  - the visitor's session;
  - an `ae_install` browser id (the web's `X-Install-Id`);
  - their IP and User-Agent.

  So the lead, the daily limit and the sign-in rule are the same as the app's.

- **After a reveal:** a phone dials straight away (`tel:`). A computer shows the number. WhatsApp opens in a new tab.
- **View count:** views are counted by a beacon to `POST /api/posts/:id/view`, which always answers 204.

**9. JavaScript.**

- **Server-first:** the pages are server components. Client code is only:
  - the contact buttons;
  - the view beacon;
  - the site header.
- **The `radix-ui` fix:** `radix-ui` is a barrel package, and importing only `Slot` from it (`components/ui/button`)
  pulled every primitive into every page. `experimental.optimizePackageImports: ['radix-ui']` fixes that:
  - first-load JS: home 184 → 107 kB;
  - listing detail: 224 → 149 kB.
- **Headings:** the category cards are `h2`, since they sit directly under the page's `h1`.

## Performance and SEO (Lighthouse, mobile)

Lighthouse 13.5, **mobile emulation** (its default: simulated slow 4G, 150 ms RTT, 4× CPU slowdown). Setup:

- the production build (`next start`) against the e2e stub API, with 24 live listings of 3 photos each (real WebP at
  the API's thumb/card/full sizes);
- each page warmed once, as a live site's data cache is;
- three runs per page. The report kept is the median run: [`docs/perf/lighthouse/`](../perf/lighthouse/).

| Page                       | Performance | SEO | Accessibility | Best practices | FCP   | LCP   | TBT    | CLS |
| -------------------------- | ----------- | --- | ------------- | -------------- | ----- | ----- | ------ | --- |
| `/` (home)                 | 91          | 100 | 97            | 96             | 0.9 s | 2.9 s | 250 ms | 0   |
| `/category/mobile-phones`  | 90          | 100 | 96            | 96             | 0.9 s | 2.9 s | 250 ms | 0   |
| `/listing/<id>/<slug>`     | 94          | 100 | 97            | 96             | 0.9 s | 2.7 s | 170 ms | 0   |
| `/store/rahim-electronics` | 93          | 100 | 96            | 96             | 0.9 s | 2.8 s | 170 ms | 0   |

All three runs of every page scored Performance 90–95 and SEO 100 (targets: 85+ and 95+).

**What the runs changed:**

- **JavaScript:** the first run scored Performance 84, with 430 ms TBT. The `radix-ui` barrel (decision 9) was the
  cause.
- **Layout shift:** the root `loading.tsx` skeleton is now at least a screen tall (`min-h-svh`). Before, the footer
  jumped when the page streamed in (CLS 0.15).
- **Heading order:** category cards are `h2` (directly under the page's `h1`).

**Known and outside this change:**

- Best practices 96: there is no `favicon.ico` (404).
- Accessibility: the header's "পোস্ট করুন" (post) button has too little colour contrast (brand tokens).

**Not measured:** a real phone on a real network. The stub answers instantly, so server time here is a warm cache's,
which is what the data cache gives in production. A cold render adds the API's time.

To reproduce, with the stub (`pnpm --filter @amar-elaka/e2e stub`) and the web build (`next start`, the e2e env)
running:

```
CHROME_PATH=<chromium> npx lighthouse@13 http://mirpur.localhost:3001/<page> \
  --only-categories=performance,seo,accessibility,best-practices --output=html
```

## Consequences

- **Settings (seeded and in the registry):**
  - `sold_noindex_days`;
  - `web_home_revalidate_seconds`, `web_category_revalidate_seconds`, `web_listing_revalidate_seconds`;
  - `sitemap_urls_per_file`.

  The tenant config's `web` block carries them to the web.

- **API tests:** the statuses (live, sold, gone, not found, legal hold, cross-tenant), sitemaps, the store without a
  phone, and the share image (PNG 1200×630, cached, 404 for non-public).
- **Web unit tests:** the slug (conjuncts, NFC, ZWJ, truncation), the filters, and the JSON-LD builders.
- **Playwright tests:**
  - 308 to the canonical slug and to the owning host;
  - 410 and 404;
  - Bengali titles, canonical URLs and robots;
  - Product, ItemList, LocalBusiness and BreadcrumbList;
  - no phone in the HTML, then a reveal that records one lead;
  - sold kept, then `noindex`;
  - filters and pagination;
  - the sitemap index and its split;
  - the share image on the tenant host.
- **Not yet:** the store page is basic (no hours, map or reviews; reviews come in months 3–5); no `hreflang` (Bengali
  only for now).
