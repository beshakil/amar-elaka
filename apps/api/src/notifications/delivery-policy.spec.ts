import {
  chooseChannels,
  configurableChannels,
  overCap,
  quietHoursEnd,
  startOfLocalDay,
  type TypeRules,
} from './delivery-policy';

const DHAKA = 'Asia/Dhaka';
const chat: TypeRules = {
  code: 'new_message',
  defaultChannels: ['in_app', 'push'],
  urgent: false,
  smsEligible: false,
  collapsible: true,
  userConfigurable: true,
};
const ban: TypeRules = {
  code: 'ban_issued',
  defaultChannels: ['in_app', 'push', 'sms'],
  urgent: true,
  smsEligible: true,
  collapsible: false,
  userConfigurable: false,
};
const everything = { hasVerifiedPhone: true, hasVerifiedEmail: true, pushDevices: 2 };
const none = new Map();

describe('chooseChannels (ADR 059)', () => {
  it('takes the type defaults the recipient can be reached on', () => {
    expect(chooseChannels(chat, none, everything, [])).toEqual(['push']);
    expect(chooseChannels(chat, none, { ...everything, pushDevices: 0 }, [])).toEqual([]);
    expect(chooseChannels(ban, none, everything, [])).toEqual(['push', 'sms']);
  });

  it('follows the user’s preferences for a configurable type', () => {
    expect(chooseChannels(chat, new Map([['push', false]]), everything, [])).toEqual([]);
    expect(chooseChannels(chat, new Map([['email', true]]), everything, [])).toEqual([
      'push',
      'email',
    ]);
  });

  it('ignores preferences for a type the user can’t switch off', () => {
    expect(
      chooseChannels(
        ban,
        new Map([
          ['push', false],
          ['sms', false],
        ]),
        everything,
        [],
      ),
    ).toEqual(['push', 'sms']);
  });

  it('never sends SMS for a type that isn’t SMS-eligible unless an admin listed it', () => {
    expect(chooseChannels(chat, new Map([['sms', true]]), everything, [])).toEqual(['push']);
    expect(chooseChannels(chat, new Map([['sms', true]]), everything, ['new_message'])).toEqual([
      'push',
      'sms',
    ]);
    expect(configurableChannels(chat, [])).toEqual(['push', 'email']);
    expect(configurableChannels(ban, [])).toEqual([]);
  });
});

describe('quietHoursEnd', () => {
  // 23:30 Dhaka = 17:30 UTC.
  it('holds a 23:30 push until 08:00 the next morning (window wrapping midnight)', () => {
    expect(quietHoursEnd(new Date('2026-10-10T17:30:00Z'), '22:00', '08:00', DHAKA)).toEqual(
      new Date('2026-10-11T02:00:00Z'),
    );
  });

  it('holds a 03:15 push until 08:00 the same morning', () => {
    expect(quietHoursEnd(new Date('2026-10-10T21:15:30Z'), '22:00', '08:00', DHAKA)).toEqual(
      new Date('2026-10-11T02:00:00Z'),
    );
  });

  it('is off in the daytime, at the end minute, and when start = end', () => {
    expect(quietHoursEnd(new Date('2026-10-10T06:00:00Z'), '22:00', '08:00', DHAKA)).toBeNull();
    expect(quietHoursEnd(new Date('2026-10-11T02:00:00Z'), '22:00', '08:00', DHAKA)).toBeNull();
    expect(quietHoursEnd(new Date('2026-10-10T17:30:00Z'), '22:00', '22:00', DHAKA)).toBeNull();
  });

  it('handles a window that doesn’t wrap', () => {
    // 13:30 Dhaka inside 13:00–14:00.
    expect(quietHoursEnd(new Date('2026-10-10T07:30:00Z'), '13:00', '14:00', DHAKA)).toEqual(
      new Date('2026-10-10T08:00:00Z'),
    );
  });
});

describe('startOfLocalDay', () => {
  it('is Dhaka midnight', () => {
    expect(startOfLocalDay(new Date('2026-10-10T20:15:42.123Z'), DHAKA)).toEqual(
      new Date('2026-10-10T18:00:00Z'),
    );
  });
});

describe('overCap', () => {
  const caps = { daily: 20, perType: { new_message: 3 } };
  it('caps all types together and per type', () => {
    expect(overCap(chat, { all: 2, ofType: 2 }, caps)).toBe(false);
    expect(overCap(chat, { all: 3, ofType: 3 }, caps)).toBe(true);
    expect(overCap(chat, { all: 20, ofType: 0 }, caps)).toBe(true);
  });

  it('never caps an urgent type', () => {
    expect(overCap(ban, { all: 500, ofType: 500 }, { daily: 0, perType: { ban_issued: 0 } })).toBe(
      false,
    );
  });
});
