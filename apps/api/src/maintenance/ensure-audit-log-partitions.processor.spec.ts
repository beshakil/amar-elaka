import type { Job, Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { TenantContext } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import type { EnsureAuditLogPartitionsJob } from '../queue/queue.types';
import { EnsureAuditLogPartitionsProcessor } from './ensure-audit-log-partitions.processor';

function fakeLogger(): { logger: PinoLogger; infoSpy: jest.Mock } {
  const infoSpy = jest.fn();
  const logger = { setContext: jest.fn(), warn: jest.fn(), info: infoSpy } as unknown as PinoLogger;
  return { logger, infoSpy };
}

function fakeJob(
  data: EnsureAuditLogPartitionsJob,
  overrides: Partial<Job<EnsureAuditLogPartitionsJob>> = {},
) {
  return {
    name: 'ensure-audit-log-partitions',
    data,
    id: 'job-1',
    attemptsMade: 1,
    opts: { attempts: 1 },
    ...overrides,
  } as Job<EnsureAuditLogPartitionsJob>;
}

class FakeTenantDb {
  constructor(private readonly createdCount: number) {}
  transaction<T>(work: (tx: unknown) => Promise<T> | T): Promise<T> {
    const tx = {
      execute: () => Promise.resolve([{ ensure_audit_log_partitions: this.createdCount }]),
    };
    return Promise.resolve(work(tx));
  }
}

describe('EnsureAuditLogPartitionsProcessor', () => {
  it('runs the maintenance function as the system role and logs how many partitions were created', async () => {
    const tenantDb = new FakeTenantDb(2);
    const context = new TenantContext();
    const dlq = { add: jest.fn() } as unknown as Queue;
    const { logger, infoSpy } = fakeLogger();
    const processor = new EnsureAuditLogPartitionsProcessor(
      tenantDb as unknown as TenantDb,
      context,
      dlq,
      logger,
    );

    await processor.process(fakeJob({ months: 3 }));

    expect(infoSpy).toHaveBeenCalledWith({ created: 2, months: 3 }, 'ensured audit log partitions');
    expect(context.current()).toBeUndefined();
  });

  it('relays to the dead-letter queue once retries are exhausted', async () => {
    const tenantDb = new FakeTenantDb(0);
    const context = new TenantContext();
    const addSpy = jest.fn();
    const dlq = { add: addSpy } as unknown as Queue;
    const { logger } = fakeLogger();
    const processor = new EnsureAuditLogPartitionsProcessor(
      tenantDb as unknown as TenantDb,
      context,
      dlq,
      logger,
    );
    const job = fakeJob({ months: 3 }, { attemptsMade: 1, opts: { attempts: 1 } });

    await processor.onFailed(job, new Error('boom'));

    expect(addSpy).toHaveBeenCalledTimes(1);
  });
});
