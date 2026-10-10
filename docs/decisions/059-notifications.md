# ADR 059: The notification system

**Status:** Accepted (2026-10-10).

**Code:**

- API: `apps/api/src/notifications/`
  - `NotificationService` (queues only);
  - `NotificationDispatcher` (worker);
  - `delivery-policy.ts` (channels, quiet hours, caps — pure);
  - `in-app.channel.ts` (the inbox row, collapse);
  - `channels/` (push, SMS, email);
  - `push/` (FCM v1 provider, local provider);
  - `templates/` (renderer, `NotificationTexts`);
  - `notification-outbox.relay.ts` (price drops);
  - `preferences/` (`/me/notification-preferences`, `/me/devices/push-token`);
  - `inbox/` (`GET /notifications`).
- Weekly digest: `apps/api/src/saved-searches/matching/saved-search-digest.service.ts`.
- Database: `infra/migrations/0055_notifications.sql`.
- Tests:
  - `apps/api/test/notifications.e2e-spec.ts`, `notifications.db-spec.ts`;
  - `src/notifications/**/*.spec.ts`;
  - `test/support/notification-worker.ts` (lets other suites dispatch queued notifications).

## Context

Since week 5 the code sent notifications through `NotificationService` → `NOTIFICATION_CHANNELS` (in-app only). That had four problems:

- **Delivery was inline:** in the moderator's request, the chat send, the job.
- **No text on the server:** the clients rendered every text from `type` and `params`, so nothing could go out by push, SMS or email.
- **No push at all.**
- **Nothing for limits:** no preferences, quiet hours, caps or collapse.

The 0009 schema already had what a full system needs, mostly unused:

- `notification_templates`;
- `user_notification_preferences`;
- `notification_deliveries`, with retry and cost columns;
- `user_devices.push_token`, filled in at login.

## Decision

### One system, extended

The channel interface stays the extension point. The rest of the system was rebuilt on it:

- **The channel registry:** push, SMS and email are `NotificationChannel`s under `NOTIFICATION_CHANNELS`.
- **The in-app channel** is the inbox row they all point at.
- **Senders change only in what `send()` returns.** It is `{ queued }` now, not `{ delivered }`.

The two callers that waited on `delivered` (post-expiry reminder, saved-search notifier) now mark their progress once the notification is queued. The queue is durable and retries.

### Data model, mapped onto 0009

| Asked for                                                                              | Built on                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications(tenant_id, member_id, type, title, body, data, channels_sent, read_at)` | **Per user**, as before: one inbox across tenants. Adds `tenant_id` (where it happened: its quiet hours and timezone, and who pays for an SMS), `title`, `body`, `channels_sent`, `collapse_key`, `collapse_count` and `last_event_at`. `data` is `params`. |
| `notification_templates(type, locale, channel, title_tpl, body_tpl)`                   | The existing table, plus a `variant` column (`single` / `collapsed`). Bengali and English are seeded for every type sent today; no user-facing text is in code.                                                                                             |
| `device_tokens(member_id, platform, token, last_seen_at)`                              | `user_devices` (per user, `push_token` unique). `register_push_token()` moves a token from whoever held it.                                                                                                                                                 |
| type defaults                                                                          | Columns on `notification_types`: `default_channels`, `is_urgent`, `sms_eligible`, `collapsible`, `user_configurable`, `audience`. These are data, so an admin can change them.                                                                              |

### The pipeline

1. **`send()`.** Adds a `notify` job to the `notifications` BullMQ queue and returns at once. The tenant defaults to the caller's. While queued, the dedupe key is also the job id.
2. **`dispatch()`** (worker, one transaction, system role):
   1. Load the type's rules and the recipient. An inactive user gets nothing.
   2. Write the **inbox row**, or **collapse** into an unread one of the same type and key from the last `notification_collapse_window_minutes`. The collapsed row counts up and re-renders from the `collapsed` template ("৪টি নতুন মেসেজ"). A dedupe key already used stops here.
   3. Choose **channels**: the type's defaults, switched by the user's **preferences** where the type allows it, limited to what the user can be reached on (a device, a verified phone, a verified email).
   4. Apply **caps**: `notification_daily_cap` (push, SMS and email together, per Asia/Dhaka day) and `notification_type_daily_caps`. A capped notification stays in the inbox only. Urgent types are never capped.
   5. Apply **quiet hours** (`notification_quiet_hours_start` / `_end`, default 22:00–08:00, overridable per tenant, in the tenant's timezone). A non-urgent push or SMS becomes a delayed job that runs when quiet hours end. Security and account notices go at once. Email is never held.
   6. Write one `notification_deliveries` row per channel and queue a `deliver-notification` job, inside the transaction. A job that runs before the commit retries, so no delivery is lost between the two.
3. **`deliver()`.**
   - Renders that channel's template from the row as it is now. A push held overnight says "৫টি নতুন মেসেজ" if more arrived meanwhile.
   - Sends, and records `sent` (adding to `channels_sent`) or `undeliverable`.
   - A transient failure throws, and BullMQ retries with backoff. The last failure marks the delivery `failed` and sends the job to the dead-letter queue.

### Channels

- **Push: FCM HTTP v1 for Android, iOS and the web** (the browser holds an FCM token too).
  - One provider, no new dependency: `google-auth-library` was already installed.
  - Each call has a timeout, one quick retry and typed errors. `UNREGISTERED` and token-shaped `INVALID_ARGUMENT` errors mean a dead token, which **is removed from `user_devices` at once**.
  - Every platform gets a collapse key, so updates replace each other on the device.
  - Configuration: `PUSH_PROVIDER=local|fcm` and `FCM_SERVICE_ACCOUNT_JSON`.
- **SMS: the Month 1 `SmsProvider`.** Only for SMS-eligible types (OTP, account security, bans and appeals) and the ones a platform admin lists in `notification_sms_extra_types`; SMS costs money. The cost is billed to the notification's tenant, and segments are counted.
- **Email: the Month 1 `MailService`.** The `notice` template, with the title as the subject. **Fix:** emails used to go out with no subject line.
- **In-app:** the row itself.

### Text

`renderTemplate` fills `{{name}}`, with these extras:

- `|number`: Bengali digits with South Asian grouping, e.g. "১,২৪০".
- `|taka`: money, e.g. "৳১২,০০০".
- `|date`: a date in Asia/Dhaka, e.g. "১২ অক্টোবর".
- `{{#x}}…{{/x}}` and `{{^x}}…{{/x}}` sections, which can be nested.

Plain values are never converted to Bengali digits ("iPhone 12" stays as written).

A `reasonCode` is shown in words through the new `moderation_reasons.label_bn` / `label_en` columns, unless the moderator wrote their own reason.

### Wired

| Event                                                       | Type                                                                                                          | Channels          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------- |
| Chat message                                                | `new_message`, collapsed across conversations, names the sender (the store, for its staff)                    | in-app, push      |
| Post approved / rejected / removed, with reason             | `post_*`                                                                                                      | in-app, push      |
| Post expiring soon                                          | `post_expiring`                                                                                               | in-app, push      |
| Saved search: new results                                   | `saved_search_match` (instant / daily, as before)                                                             | in-app, push      |
| Saved search: **weekly digest**                             | `saved_search_weekly_digest`, hourly job that sends only on `saved_search_weekly_digest_weekday` from `_hour` | in-app, email     |
| **Price drop on saved posts**                               | `saved_post_price_drop`, from the `post.price_dropped` outbox event (it had no consumer), collapsed           | in-app, push      |
| Claim approved / rejected                                   | `place_claim_*`                                                                                               | in-app, push      |
| Store staff invite                                          | `store_staff_invited`                                                                                         | in-app, push      |
| **Import finished**                                         | `store_import_finished` (not for dry runs)                                                                    | in-app, push      |
| Ban / appeal outcome (types ready; the ban flow is week 12) | `ban_issued`, `appeal_decided`, urgent                                                                        | in-app, push, SMS |

### Preferences API

- **`GET /me/notification-preferences`:** every type the user gets, each channel with `enabled` and `locked`.
  - In-app is always on.
  - Push and email are the user's to switch.
  - SMS appears only where it is allowed at all.
  - Security and account notices are locked on.
  - Platform-only types (geo budget alerts) are shown to platform staff only.
- **`PUT /me/notification-preferences`:** refuses a locked channel with `NOTIFICATION_PREFERENCE_LOCKED`.
- **`PUT` / `DELETE /me/devices/push-token`:** the app calls PUT on start and whenever FCM rotates the token.

## Consequences

- **The worker must run for anything to be delivered.** `pnpm dev` alone queues notifications but doesn't deliver them, unlike mail.
- **Existing e2e suites** that check an action's notification call `startNotificationWorker().dispatch(…)` first, so they exercise the real pipeline.
- **OTP SMS stays synchronous** (auth): the login screen must know at once that the code didn't leave. It is not a notification.
- **A collapsed notification keeps its place in the inbox,** which is paged by id. The push and the badge carry the news.
- **Collapse doesn't record each folded event's dedupe key.** A `notify` job retried after its commit could count one event twice; the visible effect is a count off by one.

## Not built (yet)

- The client side: Firebase Messaging in Flutter and on the web. Both need new dependencies in those apps.
- The admin template editor.
- Per-user quiet hours.
- A delivery-receipt webhook for SMS.
