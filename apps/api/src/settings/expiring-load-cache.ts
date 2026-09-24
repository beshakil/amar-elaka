import type { SettingsClock } from './settings.ports';

interface Entry<V> {
  value: V;
  expiresAt: number;
}

interface InFlight<V> {
  promise: Promise<V>;
  generation: number;
}

/**
 * Keyed cache with a TTL, one shared load per key for concurrent callers, and
 * a generation counter so a load that started before an invalidation can't
 * write its (now stale) result back into the cache.
 */
export class ExpiringLoadCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inFlight = new Map<string, InFlight<V>>();
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly clock: SettingsClock,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.clock.now()) {
      return Promise.resolve(cached.value);
    }

    const pending = this.inFlight.get(key);
    if (pending && pending.generation === this.generation) {
      return pending.promise;
    }

    const generation = this.generation;
    const promise: Promise<V> = load()
      .then((value) => {
        if (generation === this.generation) {
          this.entries.set(key, { value, expiresAt: this.clock.now() + this.ttlMs });
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key)?.promise === promise) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, { promise, generation });
    return promise;
  }

  invalidate(key?: string): void {
    this.generation += 1;
    if (key === undefined) {
      this.entries.clear();
      this.inFlight.clear();
    } else {
      this.entries.delete(key);
      this.inFlight.delete(key);
    }
  }
}
