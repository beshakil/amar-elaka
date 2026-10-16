# Secrets rotation

**Last exercised: never.**

| Secret                                                               | Effect of rotating                                                                                                                                                   | Procedure                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                                                         | Every access and refresh token becomes invalid: everyone signs in again (SMS cost). Also re-keys the storage upload/download tokens and viewer keys derived from it. | Rotate only on compromise; announce; set on api and worker together; restart both.                                          |
| `NID_HASH_SECRET`                                                    | **Breaks duplicate-NID detection** (stored hashes no longer match) and blacklist phone hashes. Never rotate casually.                                                | On compromise: there is no re-hash path (raw NIDs are never stored). Plan a migration that keeps both peppers for a window. |
| `MEILI_MASTER_KEY`                                                   | API loses search until both sides change.                                                                                                                            | Change in Meilisearch and the API env, restart.                                                                             |
| `BARIKOI_API_KEY`, `SMS_API_KEY`, `FCM_SERVICE_ACCOUNT_JSON`, `S3_*` | That provider fails until updated (graceful fallbacks exist for geo; none for SMS).                                                                                  | Update env on api and worker, restart, smoke-test sign-in / map / push.                                                     |

Secrets live only in Coolify's secret store. The repo's `.env` is for dev; `.env.example` lists names only.
