import { env } from '../../config/env';
import { LocalStorageService } from '../local/local-storage.service';
import { S3StorageService } from '../s3-storage.service';
import type { StorageBucket } from '../storage.ports';

/**
 * `pnpm --filter @amar-elaka/api storage:check [--origin https://savar.amarelaka.com ...]`
 * (in the image: `node dist/storage/cli/storage-check.js`).
 *
 * Proves the configured storage does everything the app relies on, using
 * the same StorageService the API uses — STORAGE_DRIVER=local (ADR 028; the
 * API must be running, since it serves uploads and /media) or s3 (ADR 027):
 *
 *   1. media bucket: write, read back, and fetch anonymously through
 *      STORAGE_PUBLIC_URL (public sharing must be on);
 *   2. a presigned PUT, exactly as the web and mobile uploaders send it;
 *   3. CORS for each --origin, so browsers may upload directly;
 *   4. documents bucket: write and read back, and confirm an anonymous GET
 *      is refused (it must stay private).
 *
 * Every object it writes lives under `storage-check/` and is deleted at the
 * end. Run it after creating buckets, after changing credentials, and before
 * and after switching provider.
 */

// settings-exempt: per-request timeout for this operator tool's own HTTP probes (CLAUDE.md rule 5)
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_BODY = 'amar-elaka storage check';
const PROBE_TYPE = 'text/plain';

export function parseOrigins(argv: readonly string[]): string[] {
  const origins: string[] = [];
  argv.forEach((arg, i) => {
    const value = arg.startsWith('--origin=')
      ? arg.slice('--origin='.length)
      : arg === '--origin'
        ? argv[i + 1]
        : undefined;
    if (value === undefined) return;
    const url = new URL(value);
    if (url.origin !== value.replace(/\/+$/, '')) {
      throw new Error(`--origin takes an origin like https://savar.amarelaka.com, not "${value}"`);
    }
    origins.push(url.origin);
  });
  return origins;
}

/** The message plus its root cause, e.g. "fetch failed (ECONNREFUSED 127.0.0.1:9000)". */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages = [error.message];
  let cause: unknown = error.cause;
  while (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    messages.push(code ? `${code}: ${cause.message}` : cause.message);
    cause = cause.cause;
  }
  return messages.join(' ← ');
}

type Result = { step: string; ok: boolean; detail: string };

function probe(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

async function run(origins: readonly string[]): Promise<Result[]> {
  const storage =
    env.STORAGE_DRIVER === 's3' ? new S3StorageService(env) : new LocalStorageService(env);
  const results: Result[] = [];
  const check = async (step: string, work: () => Promise<string>): Promise<void> => {
    try {
      results.push({ step, ok: true, detail: await work() });
    } catch (error) {
      results.push({ step, ok: false, detail: describe(error) });
    }
  };

  const stamp = `${Date.now()}`;
  const written: Record<StorageBucket, string[]> = { media: [], documents: [] };
  const body = Buffer.from(PROBE_BODY);

  try {
    const mediaKey = `storage-check/${stamp}-media.txt`;
    await check('media: write and read back', async () => {
      await storage.putObject('media', mediaKey, body, PROBE_TYPE);
      written.media.push(mediaKey);
      const back = await storage.getObject('media', mediaKey);
      if (!back.equals(body)) throw new Error('read back different bytes');
      return env.STORAGE_DRIVER === 's3' ? (env.S3_BUCKET_MEDIA ?? '') : 'media/';
    });

    const publicUrl = storage.getPublicUrl('media', mediaKey);
    await check('media: anonymous GET via STORAGE_PUBLIC_URL', async () => {
      const response = await probe(publicUrl);
      if (!response.ok) {
        throw new Error(
          `${publicUrl} answered ${response.status}. local: is the API running at ` +
            'API_PUBLIC_URL? s3: turn on public sharing for the media bucket and set ' +
            'STORAGE_PUBLIC_URL to its public link.',
        );
      }
      if ((await response.text()) !== PROBE_BODY) throw new Error('public URL served other bytes');
      return publicUrl;
    });

    const uploadKey = `storage-check/${stamp}-presigned.txt`;
    const upload = await storage.presignUpload('media', uploadKey, PROBE_TYPE, body.length);
    await check('media: presigned PUT (the uploaders’ path)', async () => {
      const response = await probe(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body,
      });
      written.media.push(uploadKey);
      if (!response.ok)
        throw new Error(`PUT answered ${response.status}: ${await response.text()}`);
      if (!(await storage.head('media', uploadKey))) throw new Error('object missing after PUT');
      return 'ok';
    });

    for (const origin of origins) {
      await check(`media: CORS preflight from ${origin}`, async () => {
        const response = await probe(upload.url, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers': 'content-type',
          },
        });
        const allowed = response.headers.get('access-control-allow-origin');
        if (!response.ok || (allowed !== origin && allowed !== '*')) {
          throw new Error(
            `preflight answered ${response.status}, Access-Control-Allow-Origin=${allowed ?? '(none)'}. ` +
              'Apply the CORS rule from ADR 027 to the media bucket.',
          );
        }
        return `allowed (${allowed})`;
      });
    }
    if (origins.length === 0) {
      results.push({
        step: 'media: CORS preflight',
        ok: true,
        detail: 'skipped — pass --origin <web origin> to check browser uploads',
      });
    }

    const docKey = `storage-check/${stamp}-private.txt`;
    await check('documents: write and read back', async () => {
      await storage.putObject('documents', docKey, body, PROBE_TYPE);
      written.documents.push(docKey);
      const back = await storage.getObject('documents', docKey);
      if (!back.equals(body)) throw new Error('read back different bytes');
      return env.STORAGE_DRIVER === 's3' ? (env.S3_BUCKET_DOCUMENTS ?? '') : 'documents/';
    });

    await check('documents: anonymous GET is refused', async () => {
      // Through the public media address (both drivers), and for S3 also the
      // bucket's own address, which public sharing would open up.
      const candidates = [`${env.STORAGE_PUBLIC_URL.replace(/\/+$/, '')}/${docKey}`];
      if (env.STORAGE_DRIVER === 's3') {
        candidates.push(
          `${(env.S3_ENDPOINT ?? '').replace(/\/+$/, '')}/${env.S3_BUCKET_DOCUMENTS ?? ''}/${docKey}`,
        );
      }
      const statuses: number[] = [];
      for (const url of candidates) {
        const response = await probe(url);
        if (response.ok) {
          throw new Error(`${url} is publicly readable — the documents bucket must stay private.`);
        }
        statuses.push(response.status);
      }
      return `refused (${statuses.join(', ')})`;
    });
  } finally {
    await check('clean up', async () => {
      await storage.deleteMany('media', written.media);
      await storage.deleteMany('documents', written.documents);
      return `${written.media.length + written.documents.length} objects deleted`;
    });
  }
  return results;
}

async function main(): Promise<boolean> {
  // settings-exempt: argv offset (node, script)
  const origins = parseOrigins(process.argv.slice(2));
  console.log(
    env.STORAGE_DRIVER === 's3'
      ? `Driver s3: endpoint ${env.S3_ENDPOINT ?? '(unset)'}, region ${env.S3_REGION ?? '(unset)'}`
      : `Driver local: ${env.STORAGE_LOCAL_PATH}, served by ${env.API_PUBLIC_URL ?? '(unset)'}`,
  );
  console.log(`Public media URL ${env.STORAGE_PUBLIC_URL}\n`);
  const results = await run(origins);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}\n      ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? '\nStorage is ready.' : `\n${failed} check(s) failed.`);
  return failed === 0;
}

if (require.main === module) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
