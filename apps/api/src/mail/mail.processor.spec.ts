const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn().mockReturnValue({ sendMail: mockSendMail });

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: (...args: unknown[]): unknown => mockCreateTransport(...args) },
}));

import type { Job, Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import type { SendEmailJob } from '../queue/queue.types';
import { MailProcessor, MailSendFailedException } from './mail.processor';

function fakeLogger(): PinoLogger {
  return { setContext: jest.fn(), warn: jest.fn(), info: jest.fn() } as unknown as PinoLogger;
}

function fakeJob(
  data: SendEmailJob,
  overrides: Partial<Job<SendEmailJob>> = {},
): Job<SendEmailJob> {
  return {
    name: 'send-email',
    data,
    id: 'job-1',
    attemptsMade: 1,
    opts: { attempts: 1 },
    ...overrides,
  } as Job<SendEmailJob>;
}

describe('MailProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildProcessor(): { processor: MailProcessor; addSpy: jest.Mock } {
    const addSpy = jest.fn();
    const dlq = { add: addSpy } as unknown as Queue;
    const processor = new MailProcessor(
      { SMTP_HOST: 'localhost', SMTP_PORT: 1025, SMTP_FROM: 'noreply@example.com' },
      dlq,
      fakeLogger(),
    );
    return { processor, addSpy };
  }

  it('renders the template and sends it via the SMTP transport', async () => {
    mockSendMail.mockResolvedValue({ messageId: '1' });
    const { processor } = buildProcessor();
    const job = fakeJob({
      to: 'user@example.com',
      template: 'notice',
      params: { heading: 'শিরোনাম', body: 'বার্তা' },
    });

    await processor.process(job);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const [sent] = mockSendMail.mock.calls[0] as [{ from: string; to: string; html: string }];
    expect(sent.from).toBe('noreply@example.com');
    expect(sent.to).toBe('user@example.com');
    expect(sent.html).toContain('শিরোনাম');
  });

  it('wraps a send failure in a typed exception', async () => {
    mockSendMail.mockRejectedValue(new Error('smtp down'));
    const { processor } = buildProcessor();
    const job = fakeJob({
      to: 'user@example.com',
      template: 'notice',
      params: { heading: 'x', body: 'y' },
    });

    await expect(processor.process(job)).rejects.toThrow(MailSendFailedException);
  });

  it('relays to the dead-letter queue once retries are exhausted', async () => {
    const { processor, addSpy } = buildProcessor();
    const job = fakeJob(
      { to: 'a@example.com', template: 'notice', params: {} },
      { attemptsMade: 1, opts: { attempts: 1 } },
    );

    await processor.onFailed(job, new Error('boom'));

    expect(addSpy).toHaveBeenCalledTimes(1);
  });
});
