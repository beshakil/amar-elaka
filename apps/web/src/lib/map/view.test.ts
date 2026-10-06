import { describe, expect, it } from 'vitest';
import { mapViewQuery, movedEnough, parseMapView } from './view';

const fallback = { center: { lat: 23.8, lng: 90.36 }, zoom: 13 };

describe('map view in the URL', () => {
  it('reads a shared view, and writes it back the same way', () => {
    const view = parseMapView(
      {
        lat: '23.75123',
        lng: '90.37456',
        z: '15.5',
        kinds: 'hospital,bank',
        open: '1',
        view: 'list',
      },
      fallback,
    );
    expect(view).toEqual({
      center: { lat: 23.75123, lng: 90.37456 },
      zoom: 15.5,
      kinds: ['hospital', 'bank'],
      openNow: true,
      list: true,
      shared: true,
    });
    expect(mapViewQuery(view)).toBe(
      'lat=23.75123&lng=90.37456&z=15.5&kinds=hospital%2Cbank&open=1&view=list',
    );
  });

  it('falls back on anything malformed, and keeps only kind codes', () => {
    expect(
      parseMapView({ lat: '123', lng: 'x', z: '99', kinds: 'Bad Kind,,<script>' }, fallback),
    ).toEqual({ ...fallback, kinds: null, openNow: false, list: false, shared: false });
    expect(parseMapView({ kinds: 'gas,gas,listings' }, fallback).kinds).toEqual([
      'gas',
      'listings',
    ]);
  });
});

describe('search this area', () => {
  const box = { minLng: 90.3, minLat: 23.7, maxLng: 90.4, maxLat: 23.8 };
  const shift = (fraction: number) => ({
    ...box,
    minLng: box.minLng + 0.1 * fraction,
    maxLng: box.maxLng + 0.1 * fraction,
  });
  const at = (now: typeof box, nowZoom = 14) =>
    movedEnough({ fetched: box, fetchedZoom: 14.2, now, nowZoom, ratio: 0.3 });

  it('stays hidden for a small pan, shows past the ratio or at another zoom level', () => {
    expect(at(shift(0.1))).toBe(false);
    expect(at(shift(0.5))).toBe(true);
    expect(at(box, 14.9)).toBe(false); // same zoom level
    expect(at(box, 15.1)).toBe(true);
  });
});
