import { deviceSchema } from './device.schema';

describe('deviceSchema', () => {
  it('takes the platform alone', () => {
    expect(deviceSchema.parse({ platformCode: 'android' })).toEqual({ platformCode: 'android' });
  });

  it('treats a null detail as not sent (an app sent them so; every login failed)', () => {
    const parsed = deviceSchema.parse({
      platformCode: 'android',
      appVersion: null,
      deviceModel: null,
      fingerprintHash: null,
      pushToken: null,
    });
    expect(parsed).toEqual({
      platformCode: 'android',
      appVersion: undefined,
      deviceModel: undefined,
      fingerprintHash: undefined,
      pushToken: undefined,
    });
  });

  it('keeps the details it is given, and still refuses a wrong type', () => {
    expect(deviceSchema.parse({ platformCode: 'ios', appVersion: '1.2.0' }).appVersion).toBe(
      '1.2.0',
    );
    expect(deviceSchema.safeParse({ platformCode: 'android', appVersion: 12 }).success).toBe(false);
    expect(deviceSchema.safeParse({ platformCode: 'symbian' }).success).toBe(false);
  });
});
