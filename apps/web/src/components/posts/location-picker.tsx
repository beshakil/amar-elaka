'use client';

import type { Map as MapLibreMap, Marker } from 'maplibre-gl';
import { useCallback, useEffect, useRef } from 'react';
import { BaseMap } from '@/components/map/base-map';
import type { MapConfig } from '@/lib/api/schemas';

const INITIAL_ZOOM = 15;

// A pin drawn in SVG, following the brand colour.
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44"><path d="M16 0C7.2 0 0 7.2 0 16c0 12 16 28 16 28s16-16 16-28C32 7.2 24.8 0 16 0z" fill="currentColor"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>';

/**
 * The post's point on our self-hosted base map (ADR 043): click to place the
 * pin, or drag it. `value` moves the pin when set from outside (my location,
 * address search).
 */
export function LocationPicker({
  config,
  value,
  center,
  onChange,
  label,
}: {
  config: MapConfig | null;
  value: { lat: number; lng: number } | null;
  center: { lat: number; lng: number };
  onChange: (point: { lat: number; lng: number }) => void;
  label: string;
}) {
  const map = useRef<MapLibreMap | null>(null);
  const marker = useRef<Marker | null>(null);
  /** Places (or moves) the pin; set once the map has loaded. */
  const place = useRef<((lat: number, lng: number) => void) | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const initialValue = useRef(value);

  const onReady = useCallback(
    (instance: MapLibreMap, maplibregl: typeof import('maplibre-gl')) => {
      const placePin = (lat: number, lng: number) => {
        if (!marker.current) {
          const element = document.createElement('div');
          element.innerHTML = PIN_SVG;
          element.className = 'text-destructive';
          element.title = label;
          marker.current = new maplibregl.Marker({ element, draggable: true, anchor: 'bottom' })
            .setLngLat([lng, lat])
            .addTo(instance);
          marker.current.on('dragend', () => {
            const at = marker.current?.getLngLat();
            if (at) onChangeRef.current({ lat: at.lat, lng: at.lng });
          });
        } else {
          marker.current.setLngLat([lng, lat]);
        }
      };
      const start = initialValue.current;
      if (start) placePin(start.lat, start.lng);
      instance.on('click', (event) => {
        placePin(event.lngLat.lat, event.lngLat.lng);
        onChangeRef.current({ lat: event.lngLat.lat, lng: event.lngLat.lng });
      });
      map.current = instance;
      place.current = placePin;
    },
    [label],
  );

  useEffect(
    () => () => {
      marker.current = null;
      place.current = null;
      map.current = null;
    },
    [],
  );

  useEffect(() => {
    const instance = map.current;
    if (!instance || !value) return;
    const current = marker.current?.getLngLat();
    if (current && current.lat === value.lat && current.lng === value.lng) return;
    place.current?.(value.lat, value.lng);
    instance.easeTo({
      center: [value.lng, value.lat],
      zoom: Math.max(instance.getZoom(), INITIAL_ZOOM),
    });
  }, [value]);

  const start = value ?? center;
  return (
    <BaseMap
      config={config}
      center={start}
      zoom={INITIAL_ZOOM}
      label={label}
      onReady={onReady}
      testId="location-map"
      className="h-80 w-full"
    />
  );
}
