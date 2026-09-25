# ADR 027 — Object storage: Contabo Object Storage now, Backblaze B2 later

**Status:** Accepted (2026-09-25). Supersedes the "MinIO local, R2 prod" line in CLAUDE.md and ADR 024.

## Context

- MinIO's `minio/minio` and `minio/mc` images are no longer on Docker Hub, so the dev `docker compose` stack and
  the CI `api-e2e` job could not start local object storage.
- We already run on a Contabo VPS. Contabo Object Storage is S3-compatible, cheap, and sits in the same provider
  account.
- In 6–8 months, once traffic and photo volume are known, we expect to move to Backblaze B2 (lower price per TB,
  free egress through Cloudflare).

## Decision

1. **One driver, any S3-compatible provider.** `S3StorageService` talks to whatever `S3_ENDPOINT` points at. Moving
   provider is a configuration change plus a copy of the objects. The database stores **object keys, never URLs**
   (`media_assets.storage_key`, `variants[*].key`), so no data migration is needed.
2. **Public URLs come from `STORAGE_PUBLIC_URL`**, the media bucket's public base address, whatever the provider
   calls it. It is not derived from the S3 endpoint, because each provider formats public links differently:

   | Provider             | `S3_ENDPOINT`                         | `STORAGE_PUBLIC_URL` (media bucket)                                        |
   | -------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
   | Contabo (Singapore)  | `https://sin1.contabostorage.com`     | `https://sin1.contabostorage.com/<account-hash>:<bucket>` (public sharing) |
   | Backblaze B2         | `https://s3.<region>.backblazeb2.com` | `https://f<NNN>.backblazeb2.com/file/<bucket>`                             |
   | Either, behind a CDN | unchanged                             | `https://cdn.amarelaka.com`                                                |

   The `documents` bucket (verification papers) is private. `getPublicUrl('documents', …)` throws.

3. **No local object storage.** Dev, CI and production each use their own buckets on the real provider:

   | Environment | Media bucket           | Documents bucket           | Public sharing |
   | ----------- | ---------------------- | -------------------------- | -------------- |
   | Production  | `amar-elaka-media`     | `amar-elaka-documents`     | media only     |
   | Dev         | `amar-elaka-media-dev` | `amar-elaka-documents-dev` | media only     |
   | CI          | `amar-elaka-media-ci`  | `amar-elaka-documents-ci`  | media only     |

   Keep separate S3 credentials per environment where the provider allows it, so a leaked dev key can't touch
   production.

4. **`storage:check` is the acceptance test** for any storage configuration:
   `pnpm --filter @amar-elaka/api storage:check --origin <web origin> …`. It writes, reads, fetches through the public
   URL, does a presigned PUT, checks the CORS preflight, confirms the documents bucket refuses anonymous reads, and
   cleans up. CI runs it before the e2e suites.

## Bucket settings

**CORS (media bucket only).** Browsers upload straight to storage with a presigned PUT, so the bucket must allow the
web origins. Apply with any S3 client, for example the AWS CLI:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "https://amarelaka.com",
        "https://*.amarelaka.com",
        "http://localhost:3001"
      ],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["content-type", "content-length"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

```sh
aws s3api put-bucket-cors --endpoint-url "$S3_ENDPOINT" --bucket amar-elaka-media --cors-configuration file://cors.json
```

A tenant's custom domain (`tenants.custom_domain`) must be added to `AllowedOrigins` when it goes live. Mobile
uploads don't need CORS.

**Public read (media only).** On Contabo, turn on public sharing for the media bucket and copy the link it gives
into `STORAGE_PUBLIC_URL`. On B2, make the bucket `allPublic`. Never share the documents bucket.

## CI

`api-e2e` reads these repository secrets and fails with a clear message if any is missing (it never skips):
`CI_STORAGE_PUBLIC_URL`, `CI_S3_ENDPOINT`, `CI_S3_REGION`, `CI_S3_BUCKET_MEDIA`, `CI_S3_BUCKET_DOCUMENTS`,
`CI_S3_ACCESS_KEY_ID`, `CI_S3_SECRET_ACCESS_KEY`.

## Runbook: moving to Backblaze B2

1. Create the B2 buckets. B2 bucket names are globally unique, so they may differ from the Contabo names; that's
   fine, because they only live in env. Make media `allPublic` and apply the CORS rule. Create an application key
   limited to those buckets.
2. Run `storage:check` against B2 from a shell with the B2 values exported. It must pass before anything moves.
3. Copy the objects (rclone, S3 on both sides):
   `rclone sync contabo:amar-elaka-media b2:<media-bucket> --checksum --progress`, then the same for documents.
4. Switch the production env (Coolify) to the B2 values and redeploy.
5. Run `rclone copy` again (not `sync`) to pick up anything uploaded during the switch, then run `storage:check`.
6. Keep the Contabo buckets read-only for two weeks, then cancel.

The Month 1 rule still holds: no purge during the move. Legal-hold objects are copied like everything else.

## Consequences

- Dev needs internet and Contabo credentials to upload media. Everything else (API, DB, search) still runs offline.
- CI talks to a real provider, so it tests the actual S3 dialect we ship on (Contabo, later B2), not an emulator.
- Capacity: Contabo Object Storage is sold separately from the VPS, in 250 GB units (check current pricing). The
  VPS's own disk is not
  object storage.
