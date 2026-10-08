# ADR 053: SMS gateway: BulkSMSBD

**Status:** Accepted (2026-10-07).

**Code:**

- API: `apps/api/src/auth/otp/sms/bulksmsbd-sms.provider.ts`, picked by `SMS_PROVIDER=bulksmsbd`
  (`sms-provider.module.ts`); env checks in `config/env.schema.ts`
- Clients: `SMS_DELIVERY_FAILED` worded in `apps/mobile/lib/core/network/auth_error_messages.dart` and the web's
  `messages/bn.json`
- Tests: `bulksmsbd-sms.provider.spec.ts`, `config/env.schema.spec.ts`

## Context

Phone login sends a one-time code by SMS. Since Month 1 the only real-gateway class was a stub that always threw
`SMS_PROVIDER_NOT_CONFIGURED`, so phone login could not work outside development. Both the Month 1 and Month 2 reviews
named this the top blocker for a pilot.

## Decision

**Gateway: BulkSMSBD** (bulksmsbd.net), chosen by the product owner. It is quick to open an account for, cheap enough for
a pilot, and has an approved-sender-ID flow.

**Protocol.**

- `POST https://bulksmsbd.net/api/smsapi` (form body) with `api_key`, `senderid`, `number` and `message`.
- `number` is the E.164 number without the plus (`8801711000001`).
- The answer is JSON. `response_code` 202 means accepted; 1001–1032 are request or account problems, for example 1001
  invalid number, 1002 sender ID wrong or disabled, 1007 balance insufficient, 1032 IP not whitelisted.
- `SMS_API_URL` overrides the endpoint (a sandbox or a proxy); empty means the default.

**Failure handling** (CLAUDE.md rule 5).

- Every request has a timeout (`SMS_TIMEOUT_MS`, default 10 s).
- One retry, after a timeout, a network error, a 5xx, or the gateway's own "internal error" (1005).
- Every other code is a configuration or number problem that a retry can't fix, so it fails at once.
- A failure is `SmsDeliveryFailedException` (`SMS_DELIVERY_FAILED`, 503). The apps say "couldn't send the code, try
  again"; the gateway's code goes to the logs only.
- The API key never appears in a log line.

**Configuration guards.** The API refuses to start:

- with `SMS_PROVIDER=bulksmsbd` but no `SMS_API_KEY` or `SMS_SENDER_ID`;
- in production with `SMS_PROVIDER=local`, which only logs the code (nobody could log in).

## Setting it up (operations)

1. Open a BulkSMSBD account and buy credit.
2. Apply for a sender ID in its dashboard. A non-masking number works at once; a masked brand name ("AmarElaka")
   needs approval, which takes time. Masking SMS must be in Bengali (code 1012); our OTP text is Bengali.
3. **Whitelist the API server's public IP** in the dashboard. Otherwise every send fails with 1032.
4. Set `SMS_PROVIDER=bulksmsbd`, `SMS_API_KEY` and `SMS_SENDER_ID` in Coolify.
5. Send one login code to a team phone before opening a pilot.

## Not done (later)

- **Delivery reports.** "Accepted" (202) is not "delivered". If users report missing codes, poll BulkSMSBD's report API.
- **Balance alerts.** A low balance silently becomes 1007 failures. Check the balance daily (`/api/getBalanceApi`) and
  alert, like the Barikoi budget warning.
- **A second gateway for failover.** `SmsProvider` is an interface; a fallback provider is one more class.

## Alternatives considered

- **SSL Wireless:** operator-grade and widely used for OTP, but slower onboarding.
- **Alpha SMS (sms.net.bd):** similar API and price.

Either is one more `SmsProvider` class if BulkSMSBD's delivery rate disappoints in the pilot.
