'use client';

import 'leaflet/dist/leaflet.css';
import type { Map as LeafletMap, Marker } from 'leaflet';
import {
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  OSM_MAX_ZOOM,
  OSM_TILE_URL,
} from '@amar-elaka/shared-types/map';
import { useEffect, useRef } from 'react';

const INITIAL_ZOOM = 15;

// A pin drawn in SVG: Leaflet's default marker is an image whose URL a
// bundler breaks, and this one follows the brand colour.
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44"><path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 28 16 28s16-16 16-28C32 7.2 24.8 0 16 0z" fill="currentColor"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>';

/**
 * The post's point on an OpenStreetMap map (ADR 033): click to place the pin,
 * or drag it. Leaflet touches `window`, so it loads in the browser only.
 * `value` moves the pin when set from outside (my location, address search).
 */
export function LocationPicker({
  value,
  center,
  onChange,
  label,
}: {
  value: { lat: number; lng: number } | null;
  center: { lat: number; lng: number };
  onChange: (point: { lat: number; lng: number }) => void;
  label: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<Marker | null>(null);
  /** Places (or moves) the pin; set once the map has loaded. */
  const place = useRef<((lat: number, lng: number) => void) | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !container.current || map.current) return;
      const start = value ?? center;
      const instance = L.map(container.current, { zoomControl: true }).setView(
        [start.lat, start.lng],
        INITIAL_ZOOM,
      );
      L.tileLayer(OSM_TILE_URL, {
        maxZoom: OSM_MAX_ZOOM,
        attribution: `<a href="${OSM_COPYRIGHT_URL}" target="_blank" rel="noreferrer">${OSM_ATTRIBUTION}</a>`,
      }).addTo(instance);
      const icon = L.divIcon({
        html: PIN_SVG,
        className: 'text-destructive',
        iconSize: [32, 44],
        iconAnchor: [16, 44],
      });
      const placePin = (lat: number, lng: number) => {
        if (!marker.current) {
          marker.current = L.marker([lat, lng], {
            draggable: true,
            icon,
            keyboard: true,
            title: label,
          }).addTo(instance);
          marker.current.on('dragend', () => {
            const at = marker.current?.getLatLng();
            if (!at) return;
            onChangeRef.current({ lat: at.lat, lng: at.lng });
          });
        } else {
          marker.current.setLatLng([lat, lng]);
        }
      };
      if (value) placePin(value.lat, value.lng);
      instance.on('click', (event) => {
        placePin(event.latlng.lat, event.latlng.lng);
        onChangeRef.current({ lat: event.latlng.lat, lng: event.latlng.lng });
      });
      map.current = instance;
      place.current = placePin;
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
      place.current = null;
    };
    // The map is built once; later `value`s are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !value) return;
    const current = marker.current?.getLatLng();
    if (current && current.lat === value.lat && current.lng === value.lng) return;
    place.current?.(value.lat, value.lng);
    instance.setView([value.lat, value.lng], Math.max(instance.getZoom(), INITIAL_ZOOM));
  }, [value]);

  return (
    <div
      ref={container}
      role="application"
      aria-label={label}
      data-testid="location-map"
      className="h-80 w-full overflow-hidden rounded-lg border border-border"
    />
  );
}
