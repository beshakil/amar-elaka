# Storage check

**Last exercised: locally, 2026-10-16** — against a running API with the local driver: every line PASS (media
presigned PUT, CORS preflight, documents write/read, **anonymous GET of a document refused (404)**, clean-up).

Run after every deploy, a storage driver change or a volume restore:

```sh
node apps/api/dist/storage/cli/storage-check.js --origin https://<area>.amarelaka.com [--origin …]
```

Every line must say PASS. It writes only under `storage-check/` and deletes what it wrote. Since the Month 3 review,
signed (private) reads are served `Cache-Control: private, no-store` on both drivers.
