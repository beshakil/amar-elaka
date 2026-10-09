# ADR 057: Store and seller UI

**Status:** Accepted (2026-10-09).

**Code:**

- **API:**
  - `apps/api/src/stores/products/`: the product table;
  - `stores/counter-card/`: the shop-counter QR card;
  - `stores/store-scope.ts`;
  - `common/files/qr.ts` and `pdf.ts`;
  - `posts/post-stock.ts`;
  - `engagement/store-channels.ts`;
  - migration `infra/migrations/0053_store_seller_tools.sql`.
- **Mobile:**
  - `apps/mobile/lib/features/store/`: the store page;
  - `my_store/`: "আমার দোকান", the wizard, hours, staff, stock, details;
  - `seller_dashboard/`: `fl_chart`;
  - post as a store in `post/presentation/editor/contact_step.dart`.
- **Web:**
  - `apps/web/src/app/seller/`: the Seller Web Panel;
  - `lib/seller/`;
  - `app/api/seller/import-file`;
  - `packages/ui`: the shared DataTable and its primitives.
- **Tests:**
  - API: `apps/api/test/store-seller.e2e-spec.ts`, `rls-store-managers.db-spec.ts`, `src/common/files/qr-pdf.spec.ts`;
  - web: `apps/web/src/lib/seller/*.test.ts`, `apps/e2e/tests/web-seller.spec.ts`;
  - mobile: `apps/mobile/test/features/store/` (golden tests and the happy path),
    `test/features/my_store/`, `integration_test/store_happy_path_test.dart`.

## Context

ADRs 054–056 built stores, analytics, bulk import and the WhatsApp catalog in the API. Sellers had no screens for
them. This ADR adds the screens, and the few API pieces the screens needed that did not exist:

- stock status;
- a store's product list for its staff;
- the owner and managers acting on an editor's posts;
- the counter card;
- the public page saying how to reach the store and whether you follow it.

## Decision

### API additions (0053)

**Stock.** A store product is `in_stock`, `out_of_stock` or `on_order`:

- lookup `stock_statuses`;
- column `posts.stock_status_code`, where null on a store post means in stock and a personal post has none.

It is set with `POST /posts/:id/stock` (author, owner, managers). It never re-runs moderation, because nothing a
buyer reads changed except the badge.

It shows wherever the product does:

- the feed card's badges (`out_of_stock`, `on_order`), so the store page, feed and search all show it;
- the catalog (`stockStatus`; out of stock hides the order button);
- the order endpoint, which refuses an out-of-stock product with `CONTACT_OUT_OF_STOCK`, so a stale page can't take
  the order;
- the Commerce Manager export's `availability` (`in stock` / `out of stock` / `preorder`).

**Owner and managers run the store's posts.** RLS `posts_store_manager_read` / `_update`: the owner and accepted
managers of `posts.store_id` (`can_manage_store`) may read and update every post of the store, including an editor's.

- Never a legal hold.
- No INSERT: nobody posts in an editor's name.
- No DELETE: deleting is a soft-delete UPDATE.
- The row must stay a post of a store they manage.

`PostsService.asOwner` admits the author or a store manager. A manager may change price and fields, hide, mark
sold, repost, delete and set stock. A manager may not change the photos: they are the author's uploads. A manager's
view of the post is `isMine: false` but privileged.

`file_moderation_item` accepts the manager too: a manager's price edit is re-reviewed exactly like the author's,
and the queue item still names the author.

Editors keep author-only access.

**Product table.** `GET /stores/:id/products` (store posters): every post of the store the caller may see — all of
them for the owner and managers, their own plus the public ones for an editor. Each row carries `canManage` and
`isMine`. The list is paged by `post_list_page_size_*`.

**Store page.** `GET /stores/:slug` gains:

- `url`, the page on the tenant's site, for sharing;
- `isFollowing`, the caller's own follow row;
- `contactChannels`, which of call / WhatsApp / SMS the store takes. Never the numbers. One rule decides it,
  `storeChannels` (`engagement/store-channels.ts`), the same function the contact endpoint uses.

**Catalog link.** The owner's view (`GET /stores/:id/manage`) gains `catalogUrl`. `ShareService.siteFor` is the one
place that knows a tenant's site.

**Counter card.** `GET /stores/:id/counter-card.pdf?size=a5|sticker`, plus `.png` for a preview.

- It shows the store's name, a QR code of the catalog link, the link, and Bengali instructions.
- It is drawn by sharp/Pango, so the Bengali is shaped like the share cards, at `store_counter_card_dpi` (300).
- It comes as an A5 page (ISO 216) or a square sticker of `store_counter_sticker_mm` (100 mm).
- The pixels are stored losslessly (Flate) in a minimal PDF we write ourselves. The QR code stays sharp, and the PDF
  needs no fonts.
- The QR encoder is ours: byte mode, level M, versions 1–10. It was verified by decoding its output with OpenCV for
  every version shape (1, 2, 4, 7 — version information — and 10 — two block groups — plus UTF-8 Bengali), and by
  decoding the rendered A5 and sticker PDFs after rasterizing them with poppler. The test pins those matrices.
- The decision not to add a QR or PDF library was made with the user.

### Mobile

**Store page.** Reached from a post's seller card and from "আমার দোকান".

- Banner and logo, and the verified tick.
- The open-now pill from the API's own open state (one rule, ADR 052); "আজ বন্ধ" when closed today.
- Followers and product count.
- Follow: optimistic, sign-in first.
- Call and WhatsApp through `POST /stores/:id/contact`. That's the lead. `ContactActions` now takes any reveal, so
  stores and posts share one way to open the dialer or WhatsApp.
- Share: the page's URL.
- A map pin on our own base map (not interactive, with directions).
- The catalog as a grid with category tabs, paged.

**আমার দোকান.**

- The member's stores and invitations (accept).
- Each store with what the role allows: owner and managers get the dashboard, hours, staff, details and the
  "আজ বন্ধ" switch; every store poster gets stock.
- **The wizard:** name → kind (the area's place categories, the API's rule) → location (the shared `LocationPicker`,
  purpose `store_setup`) → contact (numbers in either script, through the app's one phone rule) → logo and banner.
  The logo and banner use the same compressor and transport as post photos, and wait until ready. A likely
  duplicate nearby is shown and confirmed.
- **Hours:** each day closed or open in any number of shifts (split shifts, past midnight allowed); "copy to every
  day"; holidays, closed all day or open at other hours, with a note. Overlaps and equal times are caught on the
  phone. The per-day maximum is a setting; the API answers `HOURS_TOO_MANY_RANGES` with it.
- **Staff:** invite by number as manager or editor; pending invitations; remove.
- **Stock:** a three-way switch per product.

**Posting as a store.** The post editor's contact step offers "কার নামে পোস্ট করবেন" to anyone with an active store.
The draft keeps `storeId` (Drift schema v5); the create request sends it. Without this, a seller could not add
products to their store from the app.

**Dashboard.** The Bengali summary line, the period switcher (the API's available periods), four numbers with
their trends, an `fl_chart` line chart of views and contacts per day, a bar chart of contacts by channel, and the most
viewed products.

### Web: the Seller Web Panel (`/seller`)

Signed-in only (middleware gate), not indexed (robots disallow), and linked from the header. `/seller` goes straight
to the seller's store, or offers a choice. Each store has four sections:

- **Dashboard:** the same data with larger charts. The charts are our own server-rendered SVG (no library): a daily
  line chart with a shaded area, bars for channels with their numbers written out, top products and top search
  queries.
- **Products:** the shared DataTable (`packages/ui`, moved out of `apps/admin` so both apps run one implementation).
  - Price edited in place, keeping the post's other fields: PATCH replaces `fields` whole.
  - Stock as a select.
  - Bulk mark sold / hide / unhide / repost / delete for the selected rows, offered only where each row's state allows
    it (the "my posts" rule, `actionsFor`).
  - The bulk actions run one request at a time and report the exact reason for every row that didn't go through.
  - Every change goes through the existing post server actions.
- **Bulk import (ADR 056):** pick the category; download its template (XLSX or CSV); upload the sheet and an optional
  photos ZIP through this site's route, which presigns, puts and confirms as kind `import`. Then a dry run (default)
  or the real import, live progress, the row-by-row result in Bengali, and the report download. It also lists recent
  imports.
- **Catalog and QR:** the catalog link (copy, open, share to WhatsApp), the A5 card and the sticker as PDF downloads,
  and a preview of the card.

Downloads (template, report, card) come through one route, `/seller/:storeId/files/:file`, which maps each name to
exactly one API path with the seller's session. It is not a proxy.

### Settings

`store_counter_card_dpi` (300), `store_counter_sticker_mm` (100).

## Consequences

- Sellers run their store from the app or the web. Owners and managers can fix an editor's prices, stock and
  visibility without asking the editor.
- Store posts (from ADR 056) and managers' edits are moderated as before; managers can't swap the photos.
- `packages/ui` is now a shared dependency of admin and web. A change to the DataTable shows in both.
- Our QR encoder and PDF writer are small and pinned by tests. A change to the encoder must be re-verified with a
  decoder (the test says so).
- The mobile post editor shows the "post as" choice only when the member has an active store, so for everyone else it
  looks the same as before.
