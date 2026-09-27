import { TenantContext } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import type { EngagementRepository } from './engagement.repository';
import type { EngagementStore, PendingViews } from './engagement.store';
import { PostViewsFlushService } from './post-views-flush.service';

/** The Redis side as the flush sees it: pending batches and acks. */
class FakeStore implements Pick<EngagementStore, 'takePendingViews' | 'ackPendingViews'> {
  batches: PendingViews[] = [];

  takePendingViews(): Promise<PendingViews | null> {
    return Promise.resolve(this.batches.find((b) => b.counts.size > 0) ?? null);
  }

  ackPendingViews(batchKey: string, postIds: readonly string[]): Promise<void> {
    const batch = this.batches.find((b) => b.batchKey === batchKey)!;
    for (const id of postIds) batch.counts.delete(id);
    return Promise.resolve();
  }
}

function setup(options: { failOnChunk?: number } = {}) {
  const store = new FakeStore();
  const written: Array<Array<readonly [string, number]>> = [];
  const roles: Array<string | undefined> = [];
  const context = new TenantContext();
  const repo = {
    addViews: (_tx: unknown, chunk: ReadonlyArray<readonly [string, number]>) => {
      roles.push(context.current()?.role);
      if (options.failOnChunk === written.length) return Promise.reject(new Error('db down'));
      written.push([...chunk]);
      return Promise.resolve(chunk.length);
    },
  } as unknown as EngagementRepository;
  const tenantDb = {
    transaction: <T>(work: (tx: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDb;
  const service = new PostViewsFlushService(
    tenantDb,
    context,
    repo,
    store as unknown as EngagementStore,
  );
  return { service, store, written, roles };
}

const batch = (key: string, counts: Record<string, number>): PendingViews => ({
  batchKey: key,
  counts: new Map(Object.entries(counts)),
});

describe('PostViewsFlushService', () => {
  it('writes every pending count in chunks of batchSize, as the system', async () => {
    const { service, store, written, roles } = setup();
    store.batches.push(batch('b1', { p1: 3, p2: 1, p3: 7 }));

    const outcome = await service.flush({ batchSize: 2, maxBatches: 10 });

    expect(outcome).toEqual({ rows: 3, capped: false });
    expect(written).toEqual([
      [
        ['p1', 3],
        ['p2', 1],
      ],
      [['p3', 7]],
    ]);
    expect(roles).toEqual(['system', 'system']);
    expect(store.batches[0]!.counts.size).toBe(0);
  });

  it('stops at maxBatches and leaves the rest for the next run', async () => {
    const { service, store, written } = setup();
    store.batches.push(batch('b1', { p1: 1, p2: 1, p3: 1 }));

    expect(await service.flush({ batchSize: 1, maxBatches: 2 })).toEqual({ rows: 2, capped: true });
    expect(written).toHaveLength(2);
    expect([...store.batches[0]!.counts.keys()]).toEqual(['p3']);

    expect(await service.flush({ batchSize: 1, maxBatches: 2 })).toEqual({
      rows: 1,
      capped: false,
    });
  });

  it('acks only what committed: a failed chunk stays pending for the retry', async () => {
    const { service, store, written } = setup({ failOnChunk: 1 });
    store.batches.push(batch('b1', { p1: 2, p2: 5 }));

    await expect(service.flush({ batchSize: 1, maxBatches: 10 })).rejects.toThrow('db down');
    expect(written).toEqual([[['p1', 2]]]);
    expect([...store.batches[0]!.counts]).toEqual([['p2', 5]]);
  });

  it('has nothing to do without pending views', async () => {
    const { service, written } = setup();
    expect(await service.flush({ batchSize: 10, maxBatches: 10 })).toEqual({
      rows: 0,
      capped: false,
    });
    expect(written).toHaveLength(0);
  });
});
