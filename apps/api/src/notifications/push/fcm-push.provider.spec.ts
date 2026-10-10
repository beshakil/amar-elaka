import { FcmPushProvider, type FcmTransport } from './fcm-push.provider';
import { PushRejectedError, PushTransientError, type PushMessage } from './push-provider';

const ACCOUNT = JSON.stringify({
  project_id: 'amar-elaka-test',
  client_email: 'push@amar-elaka-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-used\n-----END PRIVATE KEY-----\n',
});
const MESSAGE: PushMessage = {
  token: 'device-token-1',
  platform: 'android',
  title: '৪টি নতুন মেসেজ',
  body: 'আপনার চ্যাটে নতুন মেসেজ এসেছে।',
  data: { type: 'new_message', notificationId: 'n-1' },
  collapseKey: 'new_message',
  urgent: false,
};

function transport(answers: { status: number; json: unknown }[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fake: FcmTransport = {
    accessToken: () => Promise.resolve('access-token'),
    post: (url, _token, body) => {
      calls.push({ url, body });
      const answer = answers.shift();
      return answer ? Promise.resolve(answer) : Promise.reject(new Error('socket hang up'));
    },
  };
  return { fake, calls };
}

const provider = (fake: FcmTransport) =>
  new FcmPushProvider({ serviceAccountJson: ACCOUNT, apiUrl: '', timeoutMs: 1000 }, fake);

describe('FcmPushProvider (ADR 059)', () => {
  it('sends an FCM v1 message with a collapse key on every platform', async () => {
    const { fake, calls } = transport([{ status: 200, json: { name: 'projects/x/messages/1' } }]);
    expect(await provider(fake).send(MESSAGE)).toEqual({
      ok: true,
      messageId: 'projects/x/messages/1',
    });
    expect(calls[0]!.url).toBe(
      'https://fcm.googleapis.com/v1/projects/amar-elaka-test/messages:send',
    );
    expect(calls[0]!.body).toMatchObject({
      message: {
        token: 'device-token-1',
        notification: { title: '৪টি নতুন মেসেজ' },
        android: { collapse_key: 'new_message', priority: 'NORMAL' },
        apns: { headers: { 'apns-collapse-id': 'new_message' } },
        webpush: { notification: { tag: 'new_message' } },
      },
    });
  });

  it('reports an unregistered token as invalid (the caller removes it)', async () => {
    const { fake } = transport([
      {
        status: 404,
        json: {
          error: {
            code: 404,
            status: 'NOT_FOUND',
            message: 'Requested entity was not found.',
            details: [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'UNREGISTERED',
              },
            ],
          },
        },
      },
    ]);
    expect(await provider(fake).send(MESSAGE)).toEqual({
      ok: false,
      invalidToken: true,
      reason: 'UNREGISTERED',
    });
  });

  it('reports a malformed registration token as invalid', async () => {
    const { fake } = transport([
      {
        status: 400,
        json: {
          error: {
            status: 'INVALID_ARGUMENT',
            message: 'The registration token is not a valid FCM registration token',
          },
        },
      },
    ]);
    expect(await provider(fake).send(MESSAGE)).toMatchObject({ ok: false, invalidToken: true });
  });

  it('retries once on 503, then succeeds', async () => {
    const { fake, calls } = transport([
      { status: 503, json: null },
      { status: 200, json: { name: 'm-2' } },
    ]);
    expect(await provider(fake).send(MESSAGE)).toEqual({ ok: true, messageId: 'm-2' });
    expect(calls).toHaveLength(2);
  });

  it('throws a transient error when FCM stays down or the network fails', async () => {
    await expect(
      provider(
        transport([
          { status: 503, json: null },
          { status: 503, json: null },
        ]).fake,
      ).send(MESSAGE),
    ).rejects.toBeInstanceOf(PushTransientError);
    await expect(provider(transport([]).fake).send(MESSAGE)).rejects.toBeInstanceOf(
      PushTransientError,
    );
  });

  it('throws a rejection for a bad message (not the token)', async () => {
    const { fake } = transport([
      {
        status: 400,
        json: { error: { status: 'INVALID_ARGUMENT', message: 'Invalid data payload' } },
      },
    ]);
    await expect(provider(fake).send(MESSAGE)).rejects.toBeInstanceOf(PushRejectedError);
  });
});
