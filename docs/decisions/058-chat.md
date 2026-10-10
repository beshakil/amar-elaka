# ADR 058: Chat

**Status:** Accepted (2026-10-10).

**Code:**

- API: `apps/api/src/chat/` — `ChatScope` (the conversation's tenant), `ChatConversationsService` (open, inbox,
  history, receipts, block, report), `ChatMessagesService` (send), `ChatImagesService`, `QuickRepliesService`,
  `ChatReportsService` (moderators), `contact-filter.ts`, `realtime/chat-socket.server.ts`,
  `realtime/chat-broadcaster.ts`, `chat.store.ts` (Redis)
- Storage: `presignDownload` on the storage port (S3 presigned GET; local `storage/local/download-token.ts` and the
  `/api/v1/storage/files/*` route); media kind `chat_image`
- Database: `infra/migrations/0054_chat.sql`
- Tests: `apps/api/test/chat.e2e-spec.ts` (two API instances), `chat.db-spec.ts`, `src/chat/contact-filter.spec.ts`,
  `src/storage/local/download-token.spec.ts`

## Context

Week 11 brings realtime chat. Most of the database already existed in 0009:

- `conversations`, `conversation_participants`, `messages`, `user_blocks`;
- participants-only RLS and idempotent sends (`unique (tenant_id, conversation_id, sender_member_id,
client_message_id)`);
- RLS that refuses a message across a block or into a locked conversation;
- `scrub_post`, which already severed a post's conversations (Q46).

What was missing was everything that makes it a chat:

- a transport, and a way to run on more than one server;
- delivery and read state;
- the contact soft-block;
- a way to report a conversation with evidence;
- the chat lead, quick replies and private photos.

The request described its own model (`buyer_member_id` / `seller_member_id`, `status`, `post_card`, per-message
`read_at`). We kept 0009's schema and mapped the request onto it:

| Requested                     | Built on                                                                         | Why                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| buyer / seller columns        | `conversation_participants` with roles buyer / seller / store_staff              | a store's conversation is answered by its owner and managers, not one seller        |
| one per (buyer, post / store) | `dedupe_key` (`post:<id>:<buyer>`, `store:<id>:<buyer>`)                         | reopening returns the existing one, whatever has happened to the post since         |
| `status`                      | `is_locked`, per-participant `is_archived`                                       | the only states anything acts on                                                    |
| `post_card`                   | `listing_card` + `listing_snapshot`                                              | `scrub_post` already neutralises exactly this                                       |
| per-message `read_at`         | per-participant watermarks (`last_delivered_message_id`, `last_read_message_id`) | one row update per receipt instead of one per message; uuid v7 ids are time-ordered |

No column was dropped or renamed. The lead reuses the existing `chat_started` channel, which seller analytics already
shows as "chat". It now fires on the first seller reply, not when a conversation is opened.

## Decision

### Where a conversation lives

- **A conversation belongs to its post's or store's tenant, not the buyer's.** Discovery is radius-based, so a buyer
  of tenant A often messages a seller in tenant B. Opening one goes through `PostOwnershipService.inTenant('ensure')`,
  the same switch posts, contacts and reports use; the buyer gets an implicit membership there (§13.37 T2).
- **Every conversation call — REST or socket — goes through `ChatScope`:**
  1. `conversation_tenant_of(id)` answers only for one of the conversation's own active participants (any of the
     caller's memberships). Anyone else gets `CHAT_CONVERSATION_NOT_FOUND`, the same as for a conversation that
     doesn't exist. A member of tenant A asking about a tenant-B conversation they aren't in included.
  2. The tenant gate's rule (suspended / terminated) applies to that tenant.
  3. The work runs as the caller's membership there, so the ordinary 0009 RLS decides. Nothing bypasses it.
- **The inbox spans tenants:** `my_conversations()` (SECURITY DEFINER, by `current_user_id()`), like `my_post_refs`
  and `my_saved_items`. Each conversation's last message is then read in its own tenant.
- **Visibility uses the one rule:**
  - opening a new conversation needs `post_is_listed()`;
  - the post's title shows while `post_is_viewable()` and the post isn't scrubbed.

### Transport, and running on more than one server

1. **Socket.IO on the API's own HTTP server, namespace `/chat`, path `/api/v1/chat/socket.io`.**
   - It is a plain provider (`ChatSocketServer`), not `@nestjs/websockets`. The global `TenantGateGuard` would refuse
     every gateway handler, and the event context is built explicitly instead.
   - Dependencies: `socket.io`, `@socket.io/redis-adapter`, and `socket.io-client` (tests only).
2. **WebSocket transport only. No long-polling, so no sticky sessions:** any instance can take any socket behind
   Traefik. Clients that can't hold a socket use REST, which offers every action.
3. **The Redis adapter shares rooms across instances.** It uses two dedicated ioredis connections (pub/sub). Rooms:
   - `user:<userId>`: every socket joins its own on connect. Messages, receipts and `conversation:updated` go to the
     participants' user rooms. They reach every device of every participant, on any instance, whether or not the thread
     is open.
   - `conv:<conversationId>`: joined through an authorised `conversation:join`. It carries only the typing indicator.
4. **No chat state lives in process memory:**
   - rate limits and presence are in Redis (`chat.store.ts`);
   - dedupe is the Postgres unique index;
   - order is the database's uuid v7.

   If an instance dies, its sockets reconnect elsewhere, and a crashed instance's presence keys expire.

5. **Catching up after a reconnect or deploy:** `GET /conversations/:id/messages?after=<lastId>`, oldest first. We do
   not use Socket.IO's connection-state recovery, which the pub/sub Redis adapter doesn't support.
6. **Cross-instance control:** `socketsLeave` / `disconnectSockets` on a room go through the adapter. A block takes
   both sides out of the typing room on every instance at once. The same call disconnects a banned user everywhere
   when the trust work wires it.
7. **Scaling past one Redis:** the same package's sharded adapter (Redis 7 `SPUBLISH`) is a configuration change.
   Cost per message: one publish per recipient room. Redis is a single point of failure for realtime, not for
   correctness — REST keeps working without the socket.
8. **The worker runs no socket server:** `ChatSocketServer` only attaches where there is an HTTP server.

### Auth on the socket

- On connect, `handshake.auth.token` is verified exactly as `JwtAuthGuard` does, and its tenant passes the gate.
  Refusals arrive as `connect_error` with `data.code`.
- **Every event runs inside a fresh `TenantContext`** built from the socket's claims — what an HTTP request gets — and
  is validated with zod. The ack carries `{ ok, data }` or `{ ok: false, error: { code, message, details } }`, never a
  stack or SQL.
- The token travels in the handshake body, never a cookie, so a page on another origin can't open an authenticated
  socket (no cross-site WebSocket hijacking) and no CORS rule is needed for the WebSocket.
- The socket closes `chat_token_grace_seconds` after the token's `exp`, with `auth:expired` emitted first, unless the
  client sends `auth:refresh` with the new token.
  - A token for a different user is answered `UNAUTHENTICATED`, and the socket closes.

### Messages, delivery states, typing, offline

- **One send path for socket and REST** (`ChatMessagesService.send`), in this order:
  1. the per-user rate limit;
  2. dedupe;
  3. locked / blocked → typed refusal;
  4. the contact check;
  5. insert as the caller (RLS);
  6. the lead;
  7. after commit: fan-out and notifications.
- **Kinds:** `text`, `image` (a ready `chat_image` uploaded through the conversation), `location`, `listing_card` (the
  client sends a `postId`; the server builds the snapshot from the feed's own post card — title, price, cover, never a
  seller or phone) and `system` (lock).
- **Delivery states:**
  - `sent` = stored (the ack);
  - `delivered` = a recipient's device acked receipt (`message:delivered`);
  - `read` = `message:read`.

  Each moves that participant's watermark forward (never back) and is broadcast as `receipt`. The conversation view
  carries `othersDeliveredUpTo` / `othersReadUpTo`.

- **Typing** is relayed to the conversation room, carries `expiresInSeconds` (`chat_typing_ttl_seconds`), and is never
  stored.
- **Offline:** the client queues messages with its own `clientMessageId` and replays them on reconnect. A replay of a
  stored id returns the stored message (`created: false`), sends nothing out again, and costs no rate limit — over the
  socket or REST, on any instance.
- **Notifications:** someone not viewing the conversation gets `new_message` through `NotificationService`.
  - "Viewing" is a Redis presence key with a TTL, refreshed by `conversation:heartbeat`.
  - There is one notification per unread streak, not per message: the dedupe key is the conversation plus the
    recipient's read watermark.
  - It never carries message text or a phone number.
  - The push channel arrives with week 11's notification work, without changing chat.

### Privacy and safety

- **Never the other party's phone.** A conversation names its counterpart by display name or store name only. A
  listing card is the server's snapshot. No chat payload carries a number — the e2e collects every REST and socket
  payload and checks five spellings.
- **Contact soft-block.** In a conversation's first `chat_contact_filter_first_messages` messages (both sides
  counted, system ones not), a message with a phone number or link is held back:
  - it is not stored and not delivered;
  - the sender gets `CHAT_CONTACT_INFO_BLOCKED` with `{ found: 'phone' | 'link', remaining }`;
  - the client keeps the text in the composer and shows a gentle Bengali notice pointing to the contact button.

  After the window it goes through, `flagged_by_filter = true` for moderation. It uses the pre-filter's own
  `containsPhoneNumber` / `countLinks`: one matcher for posts and chat, Bengali digits and split digits included
  (month-2-gaps §8.2).
  - **The tradeoff.** For the window:
    - Hard-blocking forever would make chat useless for the legitimate end of a deal ("I'll call you when I'm
      outside"), and people route around a filter anyway with spaced words or a photo of a number.
    - Allowing everything from the first message lets scrapers and scammers pull buyers off-platform at once, and loses
      the lead. A seller who wants to share contact already has the tracked contact button.

    So the window is short, and the refusal is gentle: the message isn't lost and the next step is offered. After the
    window, numbers flow but are flagged.

  - **Why per tenant** (`tenant_admin` scope): partners differ. A dense urban tenant with scam pressure may want a
    longer window; a rural one where everyone knows the shop may turn it off (0) and keep only the flag.

- **Block** (`POST/DELETE /conversations/:id/block`) writes `user_blocks`, per user and across every tenant:
  - a buyer blocks the whole seller side (seller and store staff), so a store can't keep writing through someone
    else;
  - a seller-side member blocks the buyer for themselves.

  RLS then refuses messages both ways (0009). Typing stops because everyone leaves the room. A new conversation
  across a block is refused (AE261). The blocked side is told they can't send (`CHAT_BLOCKED`); there is no silent
  shadow block.

- **Report** (`POST /conversations/:id/report`):
  - `report_conversation()` files a `reports` row (new `conversation_id` target; one open report per reporter per
    conversation);
  - it snapshots the last `chat_report_transcript_max_messages` messages into `conversation_report_snapshots`,
    including ones the sender deleted (the harasser's "unsend" is the evidence), and puts their images under
    `evidence_hold`;
  - moderators work `GET /chat-reports/queue`, `GET /chat-reports/:id` and `POST /chat-reports/:id/decision` (`lock`
    with a reason, or `dismiss`). Each decision writes `moderation_actions` in the same transaction (rule 13), and a
    lock adds a system message;
  - staff see a conversation only through the snapshot (Q13: no blanket staff read).
- **Rate limits** (settings, Redis, shared by all instances):
  - `chat_messages_per_user_per_minute`;
  - `chat_new_conversations_per_user_per_day` (reopening is free);
  - reports share the existing `reports_per_user_per_day`.
- **The chat lead:** the first seller-side reply in a conversation the buyer has written in.
  - `claim_first_seller_reply()` marks `first_seller_reply_at` under the row lock, so two racing replies give one
    lead. The lead is then written through the same `insertLead` as every contact reveal: channel `chat_started`, the
    conversation's origin source, target = the seller, actor = the buyer.
  - Counting the reply rather than the open keeps idle "hi?" conversations out of lead billing.
- **Photos are private:**
  - a `chat_image` lives in the private bucket and is uploaded through `POST /conversations/:id/images` (in the
    conversation's tenant), never `/media/presign`;
  - the worker strips all metadata, GPS included, as for post photos;
  - it is shown only through signed URLs valid `chat_media_url_ttl_seconds`: S3 presigned GET, or the local driver's
    HMAC download token, whose signing key is separate from uploads;
  - RLS lets only participants (and staff) read its row.

### Quick replies

`store_quick_replies`: up to `chat_quick_replies_per_store_max` per store, each up to `chat_quick_reply_max_length`
characters. They are managed by the store's owner and managers (`/stores/:id/quick-replies`) and listed for the
composer on the seller side of a store conversation (`GET /conversations/:id/quick-replies`). Writes are serialised
per store (advisory lock), so the cap can't be raced past.

### Store staff

The store's owner and accepted managers are participants in its conversations (`store_staff`), also for a store's
post. Editors only post (ADR 054), so they never join. The `store_members_sync_chat` trigger adds a newly accepted
manager to existing conversations and sets `left_at` for one who is removed or demoted.

### Scrub (Q46)

- `scrub_post` already nulled `conversations.post_id` (`post_context_removed`) and neutralised listing cards inside
  the post's own conversations.
- **Gap fixed:** a card of the post shared elsewhere (a store's product card in a store conversation) kept its title.
  Trigger `posts_scrub_listing_cards` turns every card of the post into `{"state":"listing_removed"}`, wherever it is,
  on the same scrub.
- The legal-hold check stays `scrub_post`'s own.
- **Also fixed:** `scrub_post` failed with "permission denied for table ad_creatives" in any tenant holding other
  media. `media_asset_is_referenced()` runs with the caller's rights, and the planner may evaluate it on unrelated rows.
  The fix grants that one table to `ae_rls_bypass`.

## Consequences

- **What a client does:**
  - Connect with the access token; join a thread when it opens it; heartbeat while it stays open.
  - Send with a client id; ack `delivered` and `read`.
  - On reconnect, replay the queue, then fetch `?after=` per open thread.
  - On token refresh, send `auth:refresh`.
- Two sockets per user per device are fine; a user's room fans out to all of them.
- Proven by `chat.e2e-spec.ts` (two API instances):
  - messages cross instances through Redis;
  - a tenant-A member can't join, read or write a tenant-B conversation;
  - the phone and link soft-block, and the per-tenant override;
  - dedupe on reconnect;
  - block stops delivery and typing;
  - the rate limit, the lead, receipts, the report → lock path, quick replies, Q46, private images and token refresh;
  - no phone number in any payload.

  `chat.db-spec.ts` covers the SQL, with every new RLS policy's cross-tenant case.

## Not built (yet)

- Offers (`offer` kind exists), editing / unsending, archive and mute endpoints, conversation search.
- `purge_message_bodies()` (the `message_body_retention_days` job, §15 T8).
- The push channel itself (week 11 notifications).
- Disconnecting a banned user's sockets: the call exists through the adapter (`disconnectSockets` on their user room);
  the ban flow will call it.
- Client UIs (mobile, web) and the admin chat-report tab.
- **Still open from month-2-gaps §4** (checked 2026-10-10): row 1 (category `phone` fields in post detail), row 3
  (place phones in `GET /places/:id` and the map preview) and row 4 (raw staff request bodies in audit logs) still
  leak numbers outside the contact endpoint; row 5 (the place-claims CSV, admin) wasn't rechecked; row 2 (store
  phones) was fixed with 0050. Chat itself sends none, but the rule isn't whole until those are fixed.
