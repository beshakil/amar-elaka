# ADR 060: Chat and notification UI (app and web)

**Status:** Accepted (2026-10-10).

**Code:**

- Mobile (`apps/mobile/lib/`):
  - `features/chat/` — `data/` (REST `ChatApi`, Socket.IO `ChatRealtime`, models), `application/`
    (`ChatOutbox`, `ChatInboxController`, `ConversationController`), `presentation/` (inbox, thread,
    bubbles, composer, report sheet, `openChat`);
  - `features/notifications/push/` (`PushMessaging` over firebase_messaging, `PushController`,
    `PushRationaleGate`), `presentation/` (center, preferences, rationale screen, in-app banner);
  - `core/routing/deep_links.dart` (one mapping for the inbox and pushes);
  - `core/storage/tables/pending_chat_messages_table.dart` (Drift schema v6).
- Web (`apps/web/src/`):
  - `app/inbox/` (`/inbox`, `/inbox/[id]`, `/inbox/new?post=`), `app/notifications/` (list, `settings`,
    `open`), `app/api/chat-token/route.ts`;
  - `components/chat/`, `components/notifications/` (bell, preferences, Web Push card);
  - `lib/chat/` (server actions, loaders, socket client, pure thread rules), `lib/notifications/`
    (actions, deep links, Web Push); `public/push-sw.js`.
- API: `infra/migrations/0056_chat_inbox.sql` (`my_conversations(… p_archived)`), `POST|DELETE
/conversations/:id/archive`, inbox `?archived=`, the post card's `price` and `cover`.
- Tests:
  - mobile `test/features/chat/` (outbox, rules, goldens, `chat_happy_path`), also on a device as
    `integration_test/chat_happy_path_test.dart`;
  - web `lib/chat/thread.test.ts`, `lib/notifications/links.test.ts`;
  - API `test/chat.e2e-spec.ts` (archive).

## Context

ADR 058 (chat) and ADR 059 (notifications) built the server side. Nothing showed it: no inbox, no thread,
no push on the phone, no bell on the site.

## Decision

### Mobile

- **Inbox:** every conversation the user is in, any area, newest activity first, with the post's photo,
  the last message, the unread badge. Swipe archives it, with an undo; the archive is its own list. It is
  kept live from the socket; a reconnect reloads the first page.
- **Thread:**
  - the post card on top; bubbles; ticks from the other side's watermarks (uuid v7 order);
  - typing (expires on its own);
  - photo through the conversation's own media path, location, quick replies for a store's staff;
  - block and report in the menu. Older messages load on scroll; every reconnect fetches what was missed.
- **Offline composer:** a message goes into Drift first (pending, a clock tick), then out by REST, oldest
  first. Network, timeout, 5xx, 429 or 401 → it stays pending, with backoff (2^n s, at most a minute), when
  the network returns and on the next start. A definite refusal (contact soft-block, blocked, locked…) →
  failed, with the reason, and edit / retry / discard. The client id is the server's dedupe key, so a
  replay never sends twice.
- **Push:**
  - firebase_messaging, configured only by `--dart-define` (`FIREBASE_API_KEY`, `FIREBASE_APP_ID`,
    `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_PROJECT_ID`). No google-services.json is committed; a build
    without them has no push and never asks.
  - We never ask at first launch. We ask after the first post is published or the first chat message is
    sent, with our Bengali explanation first and Android's prompt only on "চালু করুন". After "এখন না",
    not again for 14 days; never again once the system prompt was answered.
  - The token is registered when signed in with permission, kept fresh, and forgotten on sign-out.
  - A tapped push (from the background or a cold start) opens its exact screen through the app router.
  - A push while the app is open becomes a banner, except for the thread already on screen.
- **Notification center and preferences:** the server's rendered text. Settings group related types on
  one line (approved / rejected / removed), with a switch per channel. In-app is always on; locked
  channels are shown as on.
- **Entry points:** "মেসেজ দিন" on a post (when the seller allows chat) and on a store page. On the post
  it is a full-width row above Call / WhatsApp: three labelled buttons in one row broke the Bengali labels
  mid-word (caught by the post-detail golden).

### Web

- **No tokens in page code.** The session stays in httpOnly cookies, and every read and write goes through
  this server: server actions, the same REST endpoints as the app.
- **The socket is the one exception.** It is a direct connection to the API, which a cookie can't reach.
  It gets the short-lived access token from `GET /api/chat-token` at every (re)connect:
  - same-origin only, `no-store`;
  - behind middleware's protected prefixes, so an expired token is rotated on the way like any page's;
  - it also returns the socket origin (`CHAT_SOCKET_URL`, else API_BASE_URL's origin), so the build
    doesn't need it.
- **/inbox:** the same list; archive is a button (no swipe on a desktop); `?archived=1` for the archive.
- **/inbox/[id]:** the same thread. Offline is a retry, not storage: a message stays "sending" and is
  retried with backoff and on the browser's `online` event (a closed tab loses it, as for the photo
  uploader). Photos go through `/api/media/upload?conversation=`, which reuses the post uploader's
  server-side presign → PUT → confirm → wait, against the conversation's image endpoints.
- **Listing:** "মেসেজ দিন" links to `/inbox/new?post=`. That page is protected, so a signed-out visitor
  signs in and comes back; it opens or reopens the conversation and redirects into it.
- **Web Push:** FCM tokens through our own service worker (`/push-sw.js`), with no Firebase script in it
  and no config baked in.
  - The Firebase web config and VAPID key are `NEXT_PUBLIC_FIREBASE_*`; without them there is no push UI.
  - It is offered after the first message in a thread, and as a switch on the settings page.
  - With the site in front, a push is handed to the page (the bell refreshes) instead of a system banner.
  - A click goes to `/notifications/open`, which marks it read and redirects through the single
    deep-link mapping (`lib/notifications/links.ts`, the app's twin), only ever to a path of this site.
- **Bell:** the unread count, fetched from the browser so cached HTML never waits on it. A click opens the
  newest few, with links to all notifications and to settings.

## Consequences

- One deep-link mapping per client. Server links are stable paths (`/chat/<id>`, `/posts/<id>`); each
  client maps them to its own screens or pages.
- The web shows nothing about chat until a page asks: no socket on pages that don't need one, no chat
  badge in the header (the bell covers new messages).
- Mobile goldens: chat bubbles (long Bengali, mixed Bengali/English, every tick, pending/failed), the post
  card and an inbox row, light and dark. Times are pinned to local time, so the images are the same in any
  CI timezone.

## Not built (yet)

- Web offline storage of unsent messages, and a web chat badge with a live unread total.
- iOS push (there is no iOS app).
- Store staff managing quick replies on the web (the API exists; the seller panel doesn't show it).
