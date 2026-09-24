import { createHash } from 'node:crypto';

/**
 * Fixed namespace for this project's deterministic dev-seed ids (a
 * throwaway random v4 — meaningful only in being stable across runs).
 * Every id the seed script inserts is `seedId('<kind>:<slug>')`, so running
 * the script again derives the exact same uuid for the exact same logical
 * row, which is what makes `ON CONFLICT (id) DO UPDATE` idempotent without
 * needing to remember ids between runs.
 */
const SEED_NAMESPACE = '2b1f7e2a-5e3a-4b8b-9c0a-9e6f8f6a7b10';

/** RFC 4122 UUID v5, derived from `name`. Deterministic, not random. */
export function seedId(name: string): string {
  const namespaceBytes = Buffer.from(SEED_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant 10
  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** FNV-1a string hash, used only to seed the PRNG below. */
function hashSeed(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — small, deterministic, good enough for fake dev data. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic pseudo-random generator seeded from `name`. Reusing the
 * same name always yields the same sequence, so "random" seed data (a
 * post's price, a store's coordinates) stays identical across re-runs —
 * required for the idempotent `ON CONFLICT DO NOTHING` inserts to actually
 * mean "nothing changed", not just "no duplicate-key error".
 */
export function rngFor(name: string): () => number {
  return mulberry32(hashSeed(name));
}

export function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)]!;
}

export function intBetween(min: number, max: number, rand: () => number): number {
  return Math.floor(min + rand() * (max - min + 1));
}
