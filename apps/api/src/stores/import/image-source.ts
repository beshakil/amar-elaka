import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Fetching a seller's image URL from the server (ADR 056) — an SSRF surface,
 * so: http(s) only; every address the name resolves to must be public (no
 * loopback, private, link-local, CGNAT, multicast, unique-local); redirects
 * are followed by hand and each hop checked the same way; the body is read
 * up to a byte cap; a timeout and retries on network errors and 5xx (rule 5);
 * typed errors the import turns into a row's reason.
 *
 * Residual risk, documented: the check resolves the name before fetch()
 * resolves it again, so a rebinding DNS server could swap the answer in
 * between. The bytes still only ever become a media asset after the image
 * pipeline's own checks; nothing fetched is reflected back to the caller.
 */

export type ImageSourceReason =
  'image_url_invalid' | 'image_url_blocked' | 'image_fetch_failed' | 'image_too_large';

export class ImageSourceError extends Error {
  constructor(
    readonly reasonCode: ImageSourceReason,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchImageOptions {
  timeoutMs: number;
  attempts: number;
  maxBytes: number;
  /** Injectable for tests. */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  fetchImpl?: typeof fetch;
}

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** True when an address must never be fetched from the server. */
export function isBlockedAddress(address: string): boolean {
  // An IPv4-mapped IPv6 address (::ffff:10.0.0.1) is judged as the IPv4 it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const target = mapped ?? address;
  const family = isIP(target);
  if (family === 0) return true;
  return BLOCKED.check(target, family === 4 ? 'ipv4' : 'ipv6');
}

// settings-exempt: protocol constants — redirects followed per image, and the HTTP status classes
const MAX_REDIRECTS = 3;
// settings-exempt: see above
const HTTP_REDIRECT_MIN = 300;
// settings-exempt: see above
const HTTP_REDIRECT_MAX = 399;
// settings-exempt: see above
const HTTP_SERVER_ERROR = 500;
// settings-exempt: a short pause between retries, not a business number
const RETRY_DELAY_MS = 300;

class RetryableFetch extends Error {}

async function assertPublic(
  url: URL,
  lookup: NonNullable<FetchImageOptions['lookup']>,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host).catch(() => []);
  if (addresses.length === 0) throw new RetryableFetch(`no address for ${host}`);
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    throw new ImageSourceError('image_url_blocked', host);
  }
}

export function parseImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImageSourceError('image_url_invalid', raw);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ImageSourceError('image_url_invalid', raw);
  if (url.username || url.password) throw new ImageSourceError('image_url_invalid', raw);
  return url;
}

/** The URL passes the address checks (a dry run's check: no download). */
export async function checkImageUrl(
  raw: string,
  options: Pick<FetchImageOptions, 'lookup'> = {},
): Promise<void> {
  try {
    await assertPublic(
      parseImageUrl(raw),
      options.lookup ?? ((host) => dnsLookup(host, { all: true })),
    );
  } catch (error) {
    if (error instanceof RetryableFetch) throw new ImageSourceError('image_fetch_failed', raw);
    throw error;
  }
}

async function readCapped(response: Response, maxBytes: number, raw: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new ImageSourceError('image_too_large', raw);
  // Read chunk by chunk so a body that lies about (or omits) its length still stops at the cap.
  const body = response.body as AsyncIterable<Uint8Array> | null;
  if (!body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new ImageSourceError('image_too_large', raw);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchOnce(raw: string, options: FetchImageOptions): Promise<Buffer> {
  const lookup = options.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  const fetchImpl = options.fetchImpl ?? fetch;
  let url = parseImageUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url, lookup);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { accept: 'image/*' },
      });
    } catch {
      throw new RetryableFetch(`network error for ${url.host}`);
    }
    if (response.status >= HTTP_REDIRECT_MIN && response.status <= HTTP_REDIRECT_MAX) {
      const location = response.headers.get('location');
      if (!location) throw new ImageSourceError('image_fetch_failed', raw);
      url = parseImageUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status >= HTTP_SERVER_ERROR) throw new RetryableFetch(`HTTP ${response.status}`);
    if (!response.ok) throw new ImageSourceError('image_fetch_failed', raw);
    return readCapped(response, options.maxBytes, raw);
  }
  throw new ImageSourceError('image_fetch_failed', raw);
}

/** The image at `raw`, or an ImageSourceError saying why not. */
export async function fetchImage(raw: string, options: FetchImageOptions): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(raw, options);
    } catch (error) {
      if (!(error instanceof RetryableFetch)) throw error;
      if (attempt >= options.attempts) throw new ImageSourceError('image_fetch_failed', raw);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}
