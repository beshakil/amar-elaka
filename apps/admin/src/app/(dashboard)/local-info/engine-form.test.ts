import { describe, expect, it } from 'vitest';
import {
  asciiDigits,
  formatDepartures,
  formatStops,
  pairs,
  parseDepartures,
  parsePoint,
  parseStops,
} from './engine-form';

describe('info engine forms (phone-friendly lines)', () => {
  it('reads departures with days, fare and class; blank days = every day', () => {
    expect(parseDepartures('7.30\n16:00 | 5 | 450 | এসি\n', 'outbound')).toEqual([
      {
        direction: 'outbound',
        departureTime: '07:30',
        days: [1, 2, 3, 4, 5, 6, 7],
        fare: null,
        serviceClass: null,
      },
      {
        direction: 'outbound',
        departureTime: '16:00',
        days: [5],
        fare: '450',
        serviceClass: 'এসি',
      },
    ]);
  });

  it('takes Bengali digits from a phone keyboard', () => {
    expect(asciiDigits('০৭:৩০ | ১২৩')).toBe('07:30 | 123');
    expect(parseDepartures('০৭:৩০ | ৬৭', 'return')[0]).toMatchObject({
      departureTime: '07:30',
      days: [6, 7],
    });
  });

  it('round-trips a timetable and stops through the text form', () => {
    const schedules = [
      {
        direction: 'outbound',
        departureTime: '07:30:00',
        days: [1, 2, 3, 4, 5, 6, 7],
        fare: null,
        serviceClass: null,
      },
      { direction: 'return', departureTime: '18:00', days: [5], fare: '45.00', serviceClass: null },
    ];
    expect(formatDepartures(schedules, 'outbound')).toBe('07:30');
    expect(formatDepartures(schedules, 'return')).toBe('18:00 | 5 | 45.00');
    const stops = [{ name: { bn: 'ফার্মগেট' }, minutesFromOrigin: 25, fareFromOrigin: '30.00' }];
    expect(parseStops(formatStops(stops))).toEqual([
      { nameBn: 'ফার্মগেট', minutesFromOrigin: 25, fareFromOrigin: '30.00' },
    ]);
  });

  it('reads fee pairs and a point, dropping half lines', () => {
    expect(pairs('সাধারণ ফি | 50\nশুধু নাম')).toEqual([{ label: 'সাধারণ ফি', value: '50' }]);
    expect(parsePoint('23.81, 90.41')).toEqual({ lat: 23.81, lng: 90.41 });
    expect(parsePoint('')).toBeNull();
  });
});
