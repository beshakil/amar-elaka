import type { RouteAnswer } from '@/lib/api/schemas';

/**
 * "রাস্তায় কত দূর?" (ADR 046): one POST /geo/route per place and mode for
 * the browser session — a road route is a paid Barikoi call, asked for only
 * by the button. Reopening the panel shows the answer without a second call;
 * a failure is not kept, so the visitor can try again.
 */
const answers = new Map<string, Promise<RouteAnswer>>();

export class RouteError extends Error {
  constructor(readonly status: number) {
    super(`route failed: HTTP ${status}`);
  }
}

const key = (featureId: string, mode: string) => `${mode}:${featureId}`;

export function cachedRoute(featureId: string, mode: string): Promise<RouteAnswer> | undefined {
  return answers.get(key(featureId, mode));
}

export function roadRoute(input: {
  featureId: string;
  mode: 'car' | 'foot';
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
}): Promise<RouteAnswer> {
  const k = key(input.featureId, input.mode);
  const existing = answers.get(k);
  if (existing) return existing;
  const request = fetch('/api/geo/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: input.from, to: input.to, mode: input.mode }),
  }).then(async (response) => {
    if (!response.ok) throw new RouteError(response.status);
    return (await response.json()) as RouteAnswer;
  });
  answers.set(k, request);
  request.catch(() => answers.delete(k));
  return request;
}

/** Tests only. */
export function clearRouteCache(): void {
  answers.clear();
}
