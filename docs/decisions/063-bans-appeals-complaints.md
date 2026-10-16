# ADR 063: Bans, appeals, the global blacklist and complaints

**Status:** Accepted (2026-10-13). Builds the Q15b decision (schema.md §9.6, §9.8–§9.10, §13.28).

**Code:**

- **Database:** `infra/migrations/0059_bans_appeals.sql`.
- **Enforcement** (in `apps/api/src/auth/`):
  - `BanStateService`;
  - `guards/ban-enforcement.ts`, read by both JWT guards;
  - `ban-access.decorator.ts`;
  - the blacklist check at sign-in in `auth.service.ts`.
- **The rest of the API** (in `apps/api/src/bans/`):
  - `BansService`: issue and lift;
  - `AppealsService`: the notice, in-app and public appeals, queues and decisions;
  - `BlacklistService`;
  - `ComplaintsService`;
  - `BansJobsService`: expire-bans, escalate-appeals and complaint-sla, run in the notifications worker.
- **Admin:**
  - moderation tabs for complaints, bans, appeals and the blacklist;
  - `/moderation/bans/new`;
  - for platform admins, `/platform/appeals` and `/platform/blacklist`.
- **Mobile:** `lib/features/account_ban/`.
  - The notice, an appeal, the public appeal path and complaints.
  - `core/network/account_gate.dart` and the `AccountStateInterceptor` gate the router.
- **Web:**
  - `/account/bans`, the public `/appeal`, and `app/api/appeals/*`;
  - a banner in the seller panel;
  - the appeal link at login.
- **Tests:**
  - API: `apps/api/test/bans.db-spec.ts`, `apps/api/test/bans.e2e-spec.ts`;
  - mobile: `test/features/account_ban/`, plus redirect tests;
  - web: `lib/account/notice.test.ts`;
  - admin: the nav test.

## Context

Q15b decided the model in schema.md:

- bans are records, not a status flag;
- appeals are always reachable;
- an area can only _recommend_ a global blacklisting.

0010 created the tables (`bans`, `ban_appeals`, `blacklist_entries`), but nothing wrote them. The
API also refused **any** blacklisted person at sign-in, which is stricter than the decision. A
restricted or banned person must still sign in, to a limited scope, so they can see why and appeal.

Four questions were settled before building (2026-10-13):

- **Ban storage.** Area bans live in `bans` (restricted or banned), global ones in
  `blacklist_entries` (up to terminated). This is the Q15b split; there is no single table with a
  nullable area.
- **Recommendations.** They are `blacklist_entries` rows with status `recommended`. No separate
  recommendations table.
- **Phone matching.** It is recycle-safe (below).
- **`/appeals/status`.** It is a POST, so the OTP never lands in a URL or an access log.

## Decision

### Severities and enforcement

| Severity   | Sign in                                                         | Session                                                                              | Every other request                                                                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| restricted | yes                                                             | normal                                                                               | `@ActiveAccountRequired()` routes answer 403 `ACCOUNT_RESTRICTED`: create, edit, submit and repost a post; start or write a chat; write, edit or reply to a review; review photos; add or edit a place, claim a place, create or edit a store (Month 3 review). On the chat socket: may connect and read, may not send or type |
| banned     | yes                                                             | token `scope = [appeal:read, appeal:write, account:read]`; DB role `restricted_user` | 403 `ACCOUNT_BANNED`, except `@AppealAllowed()`: `/auth/me`, logout, logout-all, `/account/bans`, `/account/appeals`; the chat socket refuses to connect or refresh                                                                                                                                                            |
| terminated | no (`ACCOUNT_TERMINATED`); approval revokes every refresh token | none                                                                                 | 403 `ACCOUNT_TERMINATED`; public OTP appeal only                                                                                                                                                                                                                                                                               |

- **The rule.** `my_ban_state()` decides the state: an active global entry (never `watch`), else an
  active ban in the request's area.
- **Per request.**
  - Both JWT guards read it on every request.
  - `BanStateService` caches it in Redis per user and area, for `ban_state_cache_seconds` and never
    past the ban's end.
  - Any change bumps the user's version key, so a ban or a lift bites on the very next request.
  - If Redis is down, it reads the database every time rather than failing.
- **An area ban bites only in its area.** Writing into another area
  (`PostOwnershipService.inTenant('ensure')`) checks that area's state too.
- **A stale appeal-only token.** It answers **401** once its ban has ended (appeal granted, lifted or
  expired). The clients' refresh-on-401 then mints a full token and replays the request, instead of
  leaving the person locked out until the token expires.
- **Sign-in** (`blacklist_match`, in every area):
  - **The account's own entry:** terminated cannot sign in.
  - **Another account's entry:** matched by device fingerprint (the entry's, or any device that
    account used), or by **phone hash**. Banned or terminated refuses sign-in with
    `ACCOUNT_BLOCKED` (403), without saying which identifier matched. A refused sign-up rolls back,
    so no account is left behind.
- **Phone hash.**
  - It is an HMAC under the identifier pepper (`NID_HASH_SECRET`, ADR 062), domain-separated with a
    `phone:` prefix. The number itself is no longer written to `blacklist_entries.phone_e164`.
  - It is computed when platform approves a recommendation, from the person's phone, read only by
    `blacklist_subject_phone()` (platform_admin only).
- **Recycle-safe phone matching (§13.21).** A phone-only match blocks for `blacklist_phone_match_days`
  after approval. After that it only flags (`watch`), because a recycled SIM's new owner shouldn't be
  locked out. A user-id or device match always counts.

### Bans and the ladder

- **Where the length comes from.** `issue_ban()` takes it from `ban_ladder_days` (`[7, 30, null]`): 7
  days, then 30 days, then permanent. The step counts the person's earlier non-revoked bans in that
  area within `ban_escalation_lookback_days`.
- **Leaving the ladder** (another number of days, or permanent early) needs a written
  `ladder_override_reason`.
- **Who decides what.** Moderators issue temporary bans. Only the area's admins issue permanent ones,
  and a permanent ban needs a reason text and at least one evidence ref (also enforced by a CHECK).
- **Who can't be banned this way.** Staff of the area and oneself (the platform can ban staff).
- **Superseding.** A new ban replaces the active one (`superseded`).
- **Audit.** Every issue, lift and appeal decision writes `moderation_actions` in the same
  transaction, with the new `ban_id` / `blacklist_entry_id` targets. The membership's
  `ban_severity_code` cache follows by trigger.
- **The internal text stays internal.** The person sees the reason _code_ (in words), never
  `reason_text` or the evidence.
- **Reference codes.** Bans get `BN-…`, blacklist entries `BL-…`, appeals `AP-…`, complaints `CP-…`.
  They are 40 random bits from `gen_random_uuid()`.

### The notice

`my_ban_notices()` and the public status show, for every area ban plus the global entries:

- severity and why (the reason code);
- how long (the end, or permanent);
- which area (its name, never a person), or "every area";
- the reference;
- where the appeal stands.

Mobile shows it at `/account/bans`; a banned session's router allows nothing else. The web shows it at
`/account/bans`, and the seller panel has a banner while the account is restricted.

### Appeals and routing

- **One appeal per ban.** An upheld appeal is final; a reduced ban is a new ban, so it can be appealed
  again.
- **The daily limit.** `appeal_rate_limit_per_day` per phone, per Dhaka calendar day, under an advisory
  lock.
- **An area ban's appeal** goes to the area's admins, with `escalate_at` set `appeal_escalation_days`
  later (the area's own setting value).
- **The area is never the final judge of its own ban.**
  - Its grant or reduce is final, because those are in the person's favour.
  - Its uphold only _recommends_: the appeal moves to the platform queue with
    `tenant_recommendation = 'uphold'` and the area's note.
  - Its direct UPDATE on `ban_appeals` is gone: the old FOR ALL policy was replaced by a read policy,
    and INSERT/UPDATE are revoked.
- **Auto-escalation.** `escalate-appeals` (hourly) moves an appeal the area hasn't decided by
  `escalate_at` to the platform (`escalation_reason = 'timeout'`).
- **Global entries' appeals** go straight to the platform. Only `platform_admin` decides there
  (`platform_support` may read).
- **What the person sees.** Their appeal is "waiting" until the decision is final; an escalation is
  internal.

### The public OTP path (terminated, or anyone who can't sign in)

- **`POST /appeals/request-otp`.** It always answers 202 with the same body, so whether a phone has a
  ban is never revealed. It sends an SMS (OTP purpose `appeal`) only if there is something to appeal.
  - The cooldown and daily limits are shared with sign-in, per phone, against SMS bombing.
  - The body carries `resendAfterSeconds`, the same value for every phone.
- **`POST /appeals/status`** (phone + OTP) returns:
  - the notices and today's appeals left;
  - an **appeal-only token** (`appeal_public_token_ttl_seconds`). Redis keeps only its SHA-256.
- **`POST /appeals/submit`** takes the OTP or that token. The token is single-use, so one SMS is
  enough (the OTP itself is single-use too).
- **The database side.** `public_appeal_status()` and `public_appeal_submit()` run as
  `app.role = 'appeal_public'` and act only on that phone.
- **No session** is ever created on this path.

### Global blacklist governance

- **Tenant admins can only recommend.**
  - `recommend_blacklist()` takes a member of their area, a reason, a severity, a summary and at least
    one evidence ref; one pending recommendation per person.
  - RLS still lets a tenant admin INSERT only `recommended` rows and never UPDATE.
- **Only `platform_admin` decides** (`decide_blacklist`, approve or reject; `revoke_blacklist`).
  - Approval takes effect in every area at once.
  - A terminated approval revokes every refresh token.
  - Each decision writes `audit_logs`, plus `moderation_actions` in the source area.
- **Tested** by DB tests (direct insert of an active row, update, function) and HTTP tests (the
  platform routes refuse an area admin).

### Complaints (distinct from content reports)

- **`complaints`** (area-scoped: the subject's area) holds:
  - the reporter;
  - the subject: a person (`user`) or a store;
  - the category: fake_seller | scam | abuse | other;
  - the priority (low | normal | high | urgent; the default comes from the category), the status
    (pending | in_progress | resolved), the assignee and the resolution;
  - `due_at` = filing time + `complaint_sla_hours_<priority>`. A priority change moves it.
- **Filing limits.** One open complaint per reporter and subject, and `complaint_max_per_day`.
- **"The person on this post".** The client sends `postId` only, and `complaint_post_author()`
  resolves the person, so the app never handles a seller's user id.
- **Assignment.** To the area's moderators, executives or admins (executives gained
  `complaints:read/write`).
- **The SLA job.** `complaint-sla` flags an overdue complaint once and tells its assignee, or else the
  area's admins.
- **Resolving with a ban.** A ban issued from a complaint (`POST /bans` with `complaintId`) resolves it
  in the same transaction.

### Notifications

- **`ban_issued`** now carries the reference and the end (SMS too). A terminated person appeals with
  that reference.
- **`appeal_decided`** knows granted, reduced and upheld.
- **New types:**
  - `ban_lifted` (SMS too);
  - for staff: `appeal_received`, `blacklist_recommended`, `complaint_assigned`,
    `complaint_sla_breached`;
  - for the reporter: `complaint_resolved`.

## Consequences

- **`bans` and `ban_appeals` take writes only through their functions.** Two older RLS tests asserted
  a tenant admin's direct UPDATE, and now assert the refusal instead.
- **Every authenticated request reads the ban state** (cached). `CacheService` now shuts down
  gracefully (`quit`) and listens for errors, so an in-flight read can't fail a shutdown.
- **`NID_HASH_SECRET` is now the identifier pepper** for phones as well. Rotating it would orphan both
  the NID duplicate check and blacklist phone matching.
- **Web after a granted appeal.** The web refreshes its session cookie only when the token expires, not
  on a 401. A seller whose appeal was granted therefore keeps the appeal-only token, and the next
  seller page sends them to sign in once. Mobile refreshes on the 401 and carries straight on.
- **Not built:**
  - attachments on appeals (`attachment_storage_keys` stays empty);
  - agent assignment for complaints beyond the area's staff;
  - the legacy `blacklist_entries.phone_e164` column. It stays for rows written before this change,
    is no longer written, and is still matched at sign-in by the old `active_blacklist_severity()`.
