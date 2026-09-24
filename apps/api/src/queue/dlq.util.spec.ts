import type { Job, Queue } from 'bullmq';
import { relayToDeadLetterQueueOnFinalFailure } from './dlq.util';

function fakeJob(overrides: Partial<Job<unknown>> = {}): Job<unknown> {
  return {
    name: 'send-email',
    data: { to: 'user@example.com' },
    attemptsMade: 1,
    opts: { attempts: 5 },
    ...overrides,
  } as Job<unknown>;
}

function fakeQueue(): { dlq: Queue; addSpy: jest.Mock } {
  const addSpy = jest.fn().mockResolvedValue(undefined);
  return { dlq: { add: addSpy } as unknown as Queue, addSpy };
}

describe('relayToDeadLetterQueueOnFinalFailure', () => {
  it('does nothing while retries remain', async () => {
    const { dlq, addSpy } = fakeQueue();
    const job = fakeJob({ attemptsMade: 2, opts: { attempts: 5 } });

    await relayToDeadLetterQueueOnFinalFailure(dlq, job, new Error('transient'));

    expect(addSpy).not.toHaveBeenCalled();
  });

  it('relays the job once every attempt has been exhausted', async () => {
    const { dlq, addSpy } = fakeQueue();
    const job = fakeJob({ attemptsMade: 5, opts: { attempts: 5 } });

    await relayToDeadLetterQueueOnFinalFailure(dlq, job, new Error('permanent'));

    expect(addSpy).toHaveBeenCalledWith('send-email', {
      originalData: { to: 'user@example.com' },
      failedReason: 'permanent',
      attemptsMade: 5,
    });
  });

  it('treats a missing attempts option as a single attempt', async () => {
    const { dlq, addSpy } = fakeQueue();
    const job = fakeJob({ attemptsMade: 1, opts: {} });

    await relayToDeadLetterQueueOnFinalFailure(dlq, job, new Error('permanent'));

    expect(addSpy).toHaveBeenCalledTimes(1);
  });
});
