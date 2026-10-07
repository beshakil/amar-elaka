# ADR 052: The in-app notification inbox

**Status:** Accepted (2026-10-07).

**Code:**

- Migration: `0047_notification_inbox` (settings only)
- API: `apps/api/src/notifications/inbox/` (`InboxModule`, registered in `AppModule` only)
- Mobile: `apps/mobile/lib/features/notifications/` (the bell in the app bar, the inbox screen, the wording)
- Tests: API `test/notification-inbox.e2e-spec.ts`; mobile `test/features/notifications/notifications_test.dart`

## Context

Since 0009, the `in_app` channel has written a `notifications` row for every notification: post decisions, expiry
reminders, saved-search matches, place, claim and edit decisions. RLS lets a user read and update only their own
rows. But nothing read them: there was no endpoint and no screen, so these notifications reached nobody.

## Decision

**API.** `GET /notifications` (signed in) returns the caller's own notifications.

- Newest first, cursor-paged; the page size comes from `notifications_page_size_default` and
  `notifications_page_size_max`.
- Archived and expired ones never show.
- Each page carries the unread count.
- `GET /notifications/unread-count` returns the badge alone.
- `POST /notifications/:id/read` marks one read; it is idempotent, and someone else's notification is a 404.
- `POST /notifications/read-all` marks all read.

The inbox is user-level: the same inbox whatever tenant the request is in.

**No text from the server.** An item is `type` plus `params` (strings), `deepLink` and `read`. The app words each type
in the reader's language (`notificationText`), so there are no hardcoded user-facing strings in the API (CLAUDE.md
rule 6). An unknown type still shows, generically, so a newer API never breaks an older app.

**A separate module.** `InboxModule` is kept apart from `NotificationsModule`. The workers import
`NotificationsModule` to send, and they have no HTTP routes or auth.

**The app.**

- A bell with the unread count sits in the app bar, for signed-in users only.
- The inbox lists the items and marks unread ones.
- Opening an item marks it read (optimistically) and follows its link when the app has that screen (`/posts/…`,
  `/saved-searches/…`). Place links have no screen yet and only mark the item read.
- The list pages on as it ends, and "mark all read" is available.

## Not done here

- Push notifications: the inbox is in-app only, as saved searches are (ADR 041).
- Archiving from the app. The column exists; nothing archives yet.
