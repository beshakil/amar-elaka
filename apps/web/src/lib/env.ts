import { z } from 'zod';

const EnvSchema = z.object({
  /** Server-to-server base URL for the NestJS API, including its /api/v1 prefix. */
  API_BASE_URL: z.string().url(),
  /** Base domain a tenant subdomain hangs off, e.g. "localhost" or "amarelaka.com". */
  APP_ROOT_DOMAIN: z.string().min(1),
  /** Absolute origin this site is served from, used for canonical URLs and sitemaps. */
  SITE_ORIGIN: z.string().url(),
  /** Public base URL for stored objects; a storage key is appended to it. */
  STORAGE_PUBLIC_URL: z.string().url(),
  /**
   * The API's public origin for the browser's chat socket (ADR 060), when it
   * differs from API_BASE_URL's (an internal hostname). Handed to the browser
   * by /api/chat-token, so it isn't baked into the build.
   */
  CHAT_SOCKET_URL: z.string().url().optional(),
});

type Env = z.infer<typeof EnvSchema>;
let validated: Env | undefined;

/**
 * Runtime configuration, validated on first use and then cached. Not at import:
 * `next build` imports route modules to collect page data, and a build must
 * not need runtime config — one image is deployed with different env. A
 * misconfigured deployment still fails loudly, on its first request.
 * Server-only: nothing here is NEXT_PUBLIC_, so it never reaches the browser.
 */
export function env(): Env {
  validated ??= EnvSchema.parse({
    API_BASE_URL: process.env.API_BASE_URL,
    APP_ROOT_DOMAIN: process.env.APP_ROOT_DOMAIN,
    SITE_ORIGIN: process.env.SITE_ORIGIN,
    STORAGE_PUBLIC_URL: process.env.STORAGE_PUBLIC_URL,
    CHAT_SOCKET_URL: process.env.CHAT_SOCKET_URL || undefined,
  });
  return validated;
}

/** Absolute URL for a storage key as returned by the API (e.g. a tenant logo). */
export function storageUrl(key: string): string {
  return `${env().STORAGE_PUBLIC_URL.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
}
