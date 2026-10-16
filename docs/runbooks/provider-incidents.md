# Provider incidents

**Last exercised: never on a server.** The fallbacks are covered by tests (geo budget and 429 fallback, SMS typed
failures, push retries).

## SMS gateway down (BulkSMSBD, ADR 053)

- Symptom: `SMS_DELIVERY_FAILED` on OTP requests; nobody new can sign in. Signed-in users are unaffected.
- The API retries once with a timeout; there is no second provider.
- Do: check the gateway's status and balance; tell users via the tenant notice board; consider raising
  `otp_resend_cooldown_seconds` so retries don't burn balance.

## Barikoi over budget or failing

- Symptom: `geo_budget_warning` / `geo_budget_exhausted` notifications (platform staff); autocomplete falls back to our
  own places and landmarks; reverse geocoding returns no address.
- Do: check `GET /analytics/geo-usage`; raise `barikoi_daily_call_budget` only within the contracted quota (still not
  recorded in ADR 044).

## Push (FCM) failing

- Deliveries stay `queued` and are retried up to `notification_outbox_max_attempts`; the in-app inbox still works.
- Do: check `FCM_SERVICE_ACCOUNT_JSON` validity and the worker logs.

## Queue backlog

- No alert exists. Watch BullMQ queue depth (`notifications`, `media`, `search`) from the worker logs or Redis.
