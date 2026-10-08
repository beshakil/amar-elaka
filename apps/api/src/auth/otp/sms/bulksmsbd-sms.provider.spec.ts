import type { PinoLogger } from 'nestjs-pino';
import {
  BULKSMSBD_DEFAULT_URL,
  BulkSmsBdProvider,
  SmsDeliveryFailedException,
  bulkSmsBdNumber,
} from './bulksmsbd-sms.provider';

const ENV = {
  SMS_API_URL: '',
  SMS_API_KEY: 'secret-key-123',
  SMS_SENDER_ID: '8809617000000',
  SMS_TIMEOUT_MS: 1000,
};

function logger() {
  return {
    setContext: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger & { warn: jest.Mock; error: jest.Mock };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('BulkSmsBdProvider (ADR 053)', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: true });
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('posts key, sender, number without the plus, and the message; 202 is sent', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ response_code: 202, success_message: 'SMS Submitted Successfully' }),
    );
    await new BulkSmsBdProvider(ENV, logger()).send('+8801711000001', 'আপনার কোড ১২৩৪৫৬');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BULKSMSBD_DEFAULT_URL);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The provider sends a URLSearchParams body.
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      api_key: 'secret-key-123',
      senderid: '8809617000000',
      number: '8801711000001',
      message: 'আপনার কোড ১২৩৪৫৬',
    });
  });

  it('SMS_API_URL overrides the endpoint', async () => {
    fetchMock.mockResolvedValueOnce(json({ response_code: 202 }));
    await new BulkSmsBdProvider(
      { ...ENV, SMS_API_URL: 'https://sandbox.example/api' },
      logger(),
    ).send('+8801711000001', 'x');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.example/api');
  });

  it('retries once after a network error, a 5xx or the gateway internal error (1005)', async () => {
    for (const first of [
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.resolve(json({}, 502)),
      () => Promise.resolve(json({ response_code: 1005, error_message: 'Internal Error' })),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockImplementationOnce(first).mockResolvedValueOnce(json({ response_code: 202 }));
      await new BulkSmsBdProvider(ENV, logger()).send('+8801711000001', 'x');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('a refused number or account problem fails at once, typed, without retrying', async () => {
    fetchMock.mockResolvedValue(
      json({ response_code: 1007, error_message: 'Balance Insufficient' }),
    );
    const log = logger();
    const failure = new BulkSmsBdProvider(ENV, log).send('+8801711000001', 'x');
    await expect(failure).rejects.toBeInstanceOf(SmsDeliveryFailedException);
    await expect(failure).rejects.toMatchObject({
      code: 'SMS_DELIVERY_FAILED',
      reason: 'bulksmsbd_1007',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The key is never logged.
    expect(JSON.stringify([log.warn.mock.calls, log.error.mock.calls])).not.toContain(
      'secret-key-123',
    );
  });

  it('gives up after two failed attempts, and on a body that is not the gateway answer', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      new BulkSmsBdProvider(ENV, logger()).send('+8801711000001', 'x'),
    ).rejects.toMatchObject({
      reason: 'network',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('<html>maintenance</html>', { status: 200 }));
    await expect(
      new BulkSmsBdProvider(ENV, logger()).send('+8801711000001', 'x'),
    ).rejects.toMatchObject({
      reason: 'bad_response_http_200',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('formats numbers the way the gateway takes them', () => {
    expect(bulkSmsBdNumber('+8801711000001')).toBe('8801711000001');
    expect(bulkSmsBdNumber('8801711000001')).toBe('8801711000001');
  });
});
