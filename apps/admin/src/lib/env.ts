import { z } from 'zod';

const EnvSchema = z.object({
  /** Server-to-server base URL for the NestJS API, including its /api/v1 prefix. */
  API_BASE_URL: z.string().url(),
  /** Marks session cookies `secure`; off for plain-HTTP local development. */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

type Env = z.infer<typeof EnvSchema>;
let validated: Env | undefined;

/**
 * Runtime configuration, validated on first use and then cached. Not at import:
 * `next build` imports route modules to collect page data, and a build must
 * not need runtime config — one image is deployed with different env. A
 * misconfigured deployment still fails loudly, on its first request.
 */
export function env(): Env {
  validated ??= EnvSchema.parse({
    API_BASE_URL: process.env.API_BASE_URL,
    NODE_ENV: process.env.NODE_ENV,
  });
  return validated;
}
