# Legal holds and personal data

**Last exercised: never on a server.** The rules are enforced in SQL and covered by DB tests; **there is no API or
admin screen to place or release a hold** — only SQL by a platform admin.

## Place a hold (SQL, platform admin)

```sql
insert into legal_holds (subject_type_code, subject_id, subject_tenant_id, reason, external_reference, placed_by_user_id)
values ('user', '<user id>', '<tenant id>', '<court order …>', '<case ref>', '<your user id>');
```

While held, `legal_hold_blocks(subject_type, subject_id)` makes every purge, scrub and anonymize path refuse: post
scrubs, review removals, the verification-document purge, media purge, stale drafts.

## Release

```sql
update legal_holds set released_by_user_id = '<you>', released_at = now(), release_reason = '…' where id = '<hold>';
```

`scrub_on_release` decides whether the delayed scrub runs afterwards.

## Retention that is promised but not enforced (Month 3 review)

- `message_body_retention_days` (180): chat bodies are kept for ever; `purge_message_bodies()` was never written.
- `lead_event_retention_months` (13): lead events are kept for ever.
- `activity_log_retention_days`: nothing writes `activity_logs` yet, and no job creates its future partitions.
- Notifications have no retention setting at all.

## Account data requests

There is no account-deletion path (Google Play requires one for apps that create accounts). Until it exists, a request
is handled by hand: ban-scrub the posts through moderation, and record the request.
