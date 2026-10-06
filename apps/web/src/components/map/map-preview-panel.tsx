'use client';

import { formatMoney } from '@amar-elaka/dynamic-form';
import type { Route } from 'next';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { MapKind, MapPointFeature, MapPreview, RouteAnswer } from '@/lib/api/schemas';
import { directionsUrl } from '@/lib/map/directions';
import { pinSvg } from '@/lib/map/pin-images';
import { cachedRoute, roadRoute, RouteError } from '@/lib/map/route-cache';
import { listingPath } from '@/lib/seo/slug';
import { BarikoiAttribution } from './barikoi-attribution';

const METERS_PER_KM = 1000;
const SECONDS_PER_MINUTE = 60;
const ROUTE_MODE = 'car';

type Road =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'answered'; answer: RouteAnswer }
  | { state: 'failed'; message: string };

type Point = { lat: number; lng: number };

/**
 * A pin's preview (ADR 046), same as the app's sheet: photo, the name in
 * HTML (Bengali shaped by the browser, never map text), kind, open/closed,
 * straight-line distance (GET /map/distance, free), address, and Call /
 * Google Maps directions / "রাস্তায় কত দূর?" (one paid route per session).
 */
export function MapPreviewPanel({
  feature,
  kind,
  user,
  locate,
  onClose,
}: {
  feature: MapPointFeature;
  kind: MapKind | undefined;
  /** The visitor's location, when known. */
  user: Point | null;
  /** Asks for the visitor's location (an explicit action); null when refused. */
  locate: () => Promise<Point | null>;
  onClose: () => void;
}) {
  const t = useTranslations('map.explorer');
  const format = useFormatter();
  const props = feature.properties;
  const [lng, lat] = feature.geometry.coordinates as [number, number];
  const [preview, setPreview] = useState<MapPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [straight, setStraight] = useState<number | null>(null);
  const [road, setRoad] = useState<Road>({ state: 'idle' });

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      layer: props.layer,
      id: props.id,
      tenant: props.tenant_id,
    });
    fetch(`/api/map/preview?${query.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setPreview((await response.json()) as MapPreview);
      })
      .catch((error: unknown) => {
        if ((error as Error).name !== 'AbortError') setFailed(true);
      });
    return () => controller.abort();
  }, [props.layer, props.id, props.tenant_id]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ from: `${user.lat},${user.lng}`, to: `${lat},${lng}` });
    fetch(`/api/map/distance?${query.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) {
          setStraight(
            ((await response.json()) as { straight_line_meters: number }).straight_line_meters,
          );
        }
      })
      .catch(() => undefined); // a nicety: the panel works without it
    return () => controller.abort();
  }, [user, lat, lng]);

  // Asked before in this session: show it at once, no new request.
  useEffect(() => {
    const cached = cachedRoute(props.id, ROUTE_MODE);
    if (cached) void show(cached);
    // `show` only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);

  async function show(answer: Promise<RouteAnswer>) {
    setRoad({ state: 'loading' });
    try {
      setRoad({ state: 'answered', answer: await answer });
    } catch (error) {
      setRoad({
        state: 'failed',
        message:
          error instanceof RouteError && error.status === 429
            ? t('routeLimited')
            : t('routeFailed'),
      });
    }
  }

  async function askRoad() {
    const from = user ?? (await locate());
    if (!from) {
      setRoad({ state: 'failed', message: t('routeNeedsLocation') });
      return;
    }
    await show(roadRoute({ featureId: props.id, mode: ROUTE_MODE, from, to: { lat, lng } }));
  }

  function distance(meters: number): string {
    return meters >= METERS_PER_KM
      ? t('km', { value: format.number(meters / METERS_PER_KM, { maximumFractionDigits: 1 }) })
      : t('meters', { value: format.number(Math.round(meters)) });
  }

  const name = props.name_bn ?? preview?.name.bn ?? props.name_en ?? preview?.name.en ?? null;
  const phone = preview?.phones[0];
  const postHref = props.layer === 'posts' && name ? listingPath(props.id, name) : null;
  const storeHref = props.layer === 'stores' && props.slug ? `/store/${props.slug}` : null;

  return (
    <section
      data-testid="map-preview"
      aria-label={name ?? t('unnamed')}
      className="space-y-2 rounded-lg border border-border bg-background p-3 shadow-lg"
    >
      {preview?.photo && (
        // A public, already-resized card image (media variants); next/image adds nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.photo.url}
          alt=""
          loading="lazy"
          className="h-36 w-full rounded-md object-cover"
        />
      )}
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-0.5 shrink-0"
          // Our own SVG (no user input).
          dangerouslySetInnerHTML={{ __html: pinSvg(kind?.icon, 28) }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold" data-testid="map-preview-name">
            {name ?? t('unnamed')}
          </h2>
          <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>{kind?.label.bn ?? t('kindOther')}</span>
            {props.open_now !== null && (
              <span
                data-testid="map-preview-open"
                className={
                  props.open_now
                    ? 'font-semibold text-green-700 dark:text-green-400'
                    : 'font-semibold text-destructive'
                }
              >
                {props.open_now ? t('isOpen') : t('isClosed')}
              </span>
            )}
          </p>
          {props.price && <p className="text-sm">৳ {formatMoney(props.price, 'bn')}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {straight !== null && (
        <p className="text-sm" data-testid="map-preview-distance">
          {t('straight', { distance: distance(straight) })}
        </p>
      )}
      {preview?.address && <p className="text-xs text-muted-foreground">{preview.address}</p>}
      {!preview && !failed && <div className="h-1 animate-pulse rounded bg-muted" />}
      {failed && <p className="text-xs text-muted-foreground">{t('previewFailed')}</p>}
      <div className="flex flex-wrap gap-2">
        {phone && (
          <Button size="sm" asChild>
            <a href={`tel:${phone}`} data-testid="map-preview-call">
              {t('call')}
            </a>
          </Button>
        )}
        {(postHref ?? storeHref) && (
          <Button size="sm" variant={phone ? 'outline' : 'primary'} asChild>
            <Link href={(postHref ?? storeHref) as Route}>{t('contact')}</Link>
          </Button>
        )}
        <Button size="sm" variant="outline" asChild>
          <a
            href={directionsUrl(lat, lng)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="map-preview-directions"
          >
            {t('directions')}
          </a>
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="map-preview-road"
          disabled={road.state === 'loading'}
          onClick={() => void askRoad()}
        >
          {t('roadDistance')}
        </Button>
      </div>
      <div aria-live="polite" className="text-sm" data-testid="route-status">
        {road.state === 'loading' && t('routing')}
        {road.state === 'failed' && road.message}
        {road.state === 'answered' && (
          <>
            {road.answer.durationSeconds !== null
              ? t('routeResult', {
                  distance: distance(road.answer.distanceMeters),
                  minutes: format.number(
                    Math.max(1, Math.round(road.answer.durationSeconds / SECONDS_PER_MINUTE)),
                  ),
                })
              : t('routeStraight', { distance: distance(road.answer.distanceMeters) })}
            {road.answer.source === 'barikoi' && <BarikoiAttribution />}
          </>
        )}
      </div>
    </section>
  );
}
