# ADR 024: Media pipeline: direct-to-storage uploads, worker-side processing

**Status:** Accepted
**Date:** 2026-09-25
**Schema:** [§4.1 `media_assets`](../specs/schema.md)
**Code:** `apps/api/src/media/` (migration `0019_media_pipeline`), `apps/mobile/lib/features/media_upload/`,
`apps/web/src/lib/media/`, `apps/web/src/components/media-uploader/`

## Context

Posts, stores and chats carry photos taken on mid-range Android phones over slow mobile data. Users upload up to 10
photos per post. The pipeline must:

- keep file bytes off the API servers (a small VPS; one proxied upload ties up a worker for seconds);
- accept only real images: a file renamed to `.jpg`, or an HTML/SVG payload sent with an image Content-Type, must never
  be stored or served;
- strip EXIF, since phone photos carry the home's GPS position;
- serve small, fast images with a placeholder while they load;
- clean up after abandoned uploads and deleted posts, without ever losing evidence or legally held media.

## Decision 1: presign → PUT to storage → confirm → worker

1. `POST /media/presign`: the API checks the declared content type and size, and the per-user rate limits (uploads per
   hour and per day, bytes per day). The limits come from `platform_settings`; the counts are kept in Redis and rolled
   back when a request is refused. It then records a `pending_upload` row and returns a presigned PUT URL. The signature covers Content-Type
   and Content-Length, so storage refuses a different type or size.
2. The client PUTs the bytes **straight to storage** (S3/R2/MinIO).
3. `POST /media/:id/confirm` does the following:
   - HEAD the object: it must exist, and its size must equal the declared size.
   - Range-GET only the first 16 bytes and match them against the allowed **magic bytes**: JPEG `FF D8 FF`, the PNG
     signature, `RIFF….WEBP`, plus PDF, MP4 and WebM for their kinds. On a mismatch, the object is deleted and the API
     returns 422.
   - Queue `process-media`.

   The API reads 16 bytes of the file, never the whole thing.

4. The **worker** (`media` BullMQ queue, `sharp`):
   - downloads the object and sniffs it again;
   - decodes it under a pixel limit, which stops decompression bombs;
   - rotates it by EXIF orientation and re-encodes the original **without metadata**;
   - writes `thumb`/`card`/`full` WebP variants (long edge 200/600/1200, never enlarged) and a ThumbHash;
   - sets `ready`.

   A file that sniffs as an image but won't decode is deleted and set to `rejected`, with no retry. Transient failures
   are retried and then go to the dead-letter queue.

Status transitions happen only in the worker, which runs as the `system` role. The `media_assets_protect_status`
trigger forbids anyone else from changing the status, which is also why the old synchronous confirm could never have
worked.

## Decision 2: ThumbHash, not BlurHash

ThumbHash encodes the aspect ratio and alpha channel, needs no component-count tuning, and is about 25 bytes. It is
stored in the new `thumbhash` column. The encoder is a small in-repo port checked byte-for-byte against the reference
implementation (`thumbhash.spec.ts`), so it adds no dependency. The unused `blurhash` column stays; dropping it is a
separate, flagged change.

## Decision 3: compress on the client as well

Both clients re-encode before upload: long edge at most 1200px, WebP, quality 0.8. The web client falls back to JPEG
where the browser can't encode WebP. A 4 MB phone photo becomes about 150 KB. This cuts upload time on 3G and removes
EXIF before the file leaves the device.

The server still does everything itself: it never trusts client compression, and old clients or scripted uploads get
the same treatment.

## Decision 4: lifecycle

- **Orphans:** hourly, uploads older than `orphan_media_hours` (24) that nothing references are **hard-deleted**, both
  the row and the objects. What counts as a reference is decided in one place, `media_asset_is_referenced()`:
  attachments, messages, ad creatives, avatars and tenant logos. A RESTRICTIVE DELETE policy lets only the system role
  delete, only unreferenced rows, and never `evidence_hold` rows.
- **Deleted posts:** a trigger soft-deletes the media that only that post uses, with `purge_due_at` from
  `media_purge_days` or `scrub_media_purge_days`. Shared media stays. Media of posts under legal hold stays. Media under
  evidence hold is soft-deleted but never becomes due.
- **Purge:** nightly (Asia/Dhaka), due media has its objects deleted and `purged_at` set. The row is kept so references
  never dangle.

## Clients

- **Mobile:** camera, or a gallery pick of up to 10 photos. A persistent upload queue survives an app restart: it is
  stored in SharedPreferences, and the compressed files are kept in app support storage. The queue runs two uploads at
  a time and retries with 2s/6s/20s backoff. Photos can be reordered and removed before submitting.
- **Web:** a drag-and-drop zone with the same queue semantics, minus persistence (a closed tab loses its `File`
  handles). XHR is used for upload progress.
- **Presign and confirm on the web** go through a transport that takes two functions, so the web auth session (not yet
  built) can supply them as server actions. `/dev/upload` previews the uploader with a simulated transport.

## Consequences

- **Production R2 needs a CORS rule** allowing `PUT` from the web origins, with the `Content-Type` header. MinIO in
  development allows everything.
- The avatar upload in the mobile app now calls `/media/presign` and `/media/:id/confirm`. The old `/media` routes are
  gone.
- Adds `sharp` (API), `flutter_image_compress` and `path_provider` (mobile).
- A photo is `processing` for a moment after confirm. Clients poll `GET /media/:id`, or simply show the local preview.
