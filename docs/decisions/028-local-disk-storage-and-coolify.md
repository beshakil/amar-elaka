# ADR 028 — Local-disk storage for dev and the first production (Coolify volume)

**Status:** Accepted (2026-09-25). Amends ADR 027: object storage (Contabo Object Storage, then Backblaze B2) becomes
the _later_ step. It is not needed to start.

## Context

- The plan is one Contabo Cloud VPS 4 running everything through Coolify, going live in about two months. Paying for
  object storage before launch buys nothing.
- Dev needs uploads to work offline, with no account, and CI needs the media suite to run without secrets.
- The code already had one `StorageService` port. Only an S3 implementation existed, and `STORAGE_DRIVER=local` was
  declared but unimplemented.

## Decision

`STORAGE_DRIVER=local` is now a full implementation (`apps/api/src/storage/local/`) with the same contract as S3.
Nothing above the storage layer knows which driver runs.

| S3 concept         | Local driver                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Bucket             | `<STORAGE_LOCAL_PATH>/media`, `<STORAGE_LOCAL_PATH>/documents`                                                |
| Object + metadata  | the file, plus `<file>.meta.json` (content type, cache control)                                               |
| Presigned PUT URL  | `${API_PUBLIC_URL}/api/v1/storage/uploads/<token>`, an HMAC-signed, 5-minute grant for one key, type and size |
| Public bucket read | `GET ${API_PUBLIC_URL}/media/<key>`, served by the API (= `STORAGE_PUBLIC_URL`). Documents are never served.  |
| Bucket CORS        | the upload route answers CORS for any origin. The token is the authorisation (no cookies), as with S3.        |

Details:

- **Same rules as S3.** The PUT must send exactly the granted `Content-Type` and `Content-Length`. The body is streamed
  to a temp file and renamed into place, so a half upload is never visible. A body longer than the grant is cut off
  and rejected.
- **Safety.** Keys must match a strict pattern (no `..`, no absolute paths, no `.meta.json`), and every path is
  checked to stay inside its bucket directory. The token key is derived from `JWT_SECRET` and used for nothing else.
- **The routes sit outside Nest** (an encapsulated Fastify plugin). The token authorises uploads, public media needs
  no tenant, and the catch-all body parser for raw image bytes must not leak into the JSON API.
- **Same keys as S3**, stored in the DB as keys, never URLs. Moving to object storage later is a copy of the two
  directories plus an env change.

## Production on the VPS with Coolify

The API and the worker are the same image (`apps/api/Dockerfile`). The API runs `node apps/api/dist/main.js` and the
worker runs `node apps/api/dist/worker.js`. **Both must mount the same persistent volume at `/app/storage`.** The API
writes originals, and the worker reads them and writes the WebP variants.

1. In Coolify, add one Persistent Storage volume (e.g. `amar-elaka-storage`), mounted at `/app/storage` on **both** the
   API and the worker resources. Without it, every redeploy deletes every photo.
2. Env on both:
   ```
   STORAGE_DRIVER=local
   STORAGE_LOCAL_PATH=/app/storage          # already the image default
   API_PUBLIC_URL=https://api.amarelaka.com
   STORAGE_PUBLIC_URL=https://api.amarelaka.com/media
   ```
3. After deploy, run `node apps/api/dist/storage/cli/storage-check.js --origin https://amarelaka.com` in the API
   container (Coolify → Terminal). Every line must say PASS.
4. **Backups.** The volume is the only copy of user photos. Include it in the VPS backup (Coolify's scheduled backups
   or `restic`/`rclone` to an off-site bucket). A dead disk without a backup loses every photo.

Limits of this setup, which are the signals to move to object storage:

- **Disk.** The VPS disk is shared with Postgres, Meilisearch, Docker images and logs. Watch usage and move when media
  passes roughly half the free space.
- **One machine.** A second API replica on another server can't see this disk.
- **Bandwidth.** Every photo view goes through the API's network. A CDN in front of `/media` helps: variants are
  `Cache-Control: immutable`.

## Moving to object storage later (Contabo Object Storage or Backblaze B2)

1. Create buckets and CORS as in ADR 027, then run `storage:check` against them with the S3 values exported.
2. Copy, leaving the sidecars behind:
   `rclone copy /app/storage/media <remote>:<media-bucket> --exclude '*.meta.json'`, and the same for `documents`. The
   keys are identical. Only the WebP variants are ever served publicly, and their `.webp` extension gives them the
   right Content-Type on upload. Originals are read only by the pipeline, which sniffs their type.
3. Switch env to `STORAGE_DRIVER=s3` plus the `S3_*` values and the new `STORAGE_PUBLIC_URL`. Redeploy.
4. `rclone copy` again to catch uploads made during the switch, then run `storage:check`. Keep the volume for two weeks.

## Consequences

- CI's `api-e2e` job needs no storage secrets, and the media suite runs end to end (upload, confirm, EXIF strip,
  variants, ThumbHash).
- A phone or emulator in dev must reach `API_PUBLIC_URL`, because uploads and images go there. Use `10.0.2.2:3000`
  for the Android emulator, or the PC's LAN IP.
- Dev no longer needs internet or an account to upload.
