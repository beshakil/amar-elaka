import { NextResponse, type NextRequest } from 'next/server';
import { listingPath, listingSlug } from './slug';

/**
 * HTTP status for the public pages, decided before anything renders
 * (ADR 039). A page can only 200 or soft-404 once the root loading.tsx has
 * streamed, so the answers crawlers rely on are given here:
 *
 *   /listing/<id>[/<slug>]  gone (expired, removed, deleted, scrubbed) → 410
 *                           never public / unknown → 404
 *                           another tenant's post → 308 to its own host
 *                           missing or wrong slug → 308 to the canonical one
 *   /category/<slug>        not a category of this tenant → 404
 *   /category/<slug>/<area> not a landing page (too few listings there,
 *                           ADR 042) → 404
 *   /store/<slug>           no such active store here → 404
 *
 * Only definite answers are cached (briefly, in this process); an API that
 * can't answer lets the page render, which shows its own error state.
 */

// Infrastructure tuning, not business rules: the same short reuse as the
// tenant resolution cache, bounded because paths are client-controlled.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5_000;
const FETCH_TIMEOUT_MS = 3_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type ListingAnswer =
  | { kind: 'show'; tenantId: string; tenantSlug: string; title: string }
  | { kind: 'gone' }
  | { kind: 'missing' };

const cacheStore = new Map<string, { value: unknown; expiresAt: number }>();

async function cached<T>(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
  const hit = cacheStore.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await load();
  if (value !== undefined) {
    if (cacheStore.size >= CACHE_MAX_ENTRIES) {
      const oldest = cacheStore.keys().next().value;
      if (oldest !== undefined) cacheStore.delete(oldest);
    }
    cacheStore.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return value;
}

/** GET from the API with the tenant header; undefined when it couldn't answer. */
async function apiGet(path: string, tenantId: string): Promise<Response | undefined> {
  try {
    const response = await fetch(`${process.env.API_BASE_URL ?? ''}${path}`, {
      headers: { accept: 'application/json', 'x-tenant-id': tenantId },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return response.status >= 500 ? undefined : response;
  } catch {
    return undefined;
  }
}

async function listingAnswer(id: string, tenantId: string): Promise<ListingAnswer | undefined> {
  return cached(`listing:${tenantId}:${id}`, async () => {
    const response = await apiGet(`/seo/listing-status/${id}`, tenantId);
    if (!response?.ok) return undefined;
    const body = (await response.json()) as {
      state?: string;
      tenantId?: string | null;
      tenantSlug?: string | null;
      title?: string | null;
    };
    if (body.state === 'gone') return { kind: 'gone' };
    if ((body.state === 'live' || body.state === 'sold') && body.tenantId && body.tenantSlug) {
      return {
        kind: 'show',
        tenantId: body.tenantId,
        tenantSlug: body.tenantSlug,
        title: body.title ?? '',
      };
    }
    return { kind: 'missing' };
  });
}

async function categoryExists(slug: string, tenantId: string): Promise<boolean | undefined> {
  const slugs = await cached(`categories:${tenantId}`, async () => {
    const response = await apiGet('/tenant/config', tenantId);
    if (!response?.ok) return undefined;
    const body = (await response.json()) as { enabledCategories?: { slug: string }[] };
    return (body.enabledCategories ?? []).map((c) => c.slug);
  });
  return slugs?.includes(slug);
}

async function areaPageExists(
  slug: string,
  area: string,
  tenantId: string,
): Promise<boolean | undefined> {
  const pairs = await cached(`category-areas:${tenantId}`, async () => {
    const response = await apiGet('/seo/category-areas', tenantId);
    if (!response?.ok) return undefined;
    const body = (await response.json()) as {
      items?: { category: { slug: string }; area: { slug: string } }[];
    };
    return (body.items ?? []).map((i) => `${i.category.slug}/${i.area.slug}`);
  });
  return pairs?.includes(`${slug}/${area}`);
}

async function storeExists(slug: string, tenantId: string): Promise<boolean | undefined> {
  return cached(`store:${tenantId}:${slug}`, async () => {
    const response = await apiGet(`/stores/${slug}?limit=1`, tenantId);
    if (!response) return undefined;
    return response.ok;
  });
}

/** Renders the app's 404 page with a real 404 status. */
function notFound(request: NextRequest): NextResponse {
  return NextResponse.rewrite(new URL('/not-found-page', request.url), { status: 404 });
}

/**
 * The visitor's own origin, as the pages build it (currentOrigin): the scheme
 * from SITE_ORIGIN, the host from the Host header. request.url carries the
 * server's internal address behind the proxy, never the tenant's host.
 */
function visitorOrigin(request: NextRequest): string {
  const scheme = new URL(process.env.SITE_ORIGIN ?? request.url).protocol;
  return `${scheme}//${request.headers.get('host') ?? request.nextUrl.host}`;
}

/** A listing's origin on another tenant's host: <slug>.<root domain>, same scheme and port. */
function tenantOrigin(request: NextRequest, tenantSlug: string): string {
  const root = process.env.APP_ROOT_DOMAIN ?? '';
  const origin = new URL(visitorOrigin(request));
  const port = origin.port ? `:${origin.port}` : '';
  return `${origin.protocol}//${tenantSlug}.${root}${port}`;
}

/**
 * The public pages' status answer, or null to render the page as it is.
 * `headers` are the request headers the page will get (tenant resolved).
 */
export async function publicPageGate(
  request: NextRequest,
  headers: Headers,
  tenantId: string | null,
): Promise<NextResponse | null> {
  if (!tenantId) return null;
  const segments = request.nextUrl.pathname.split('/').filter(Boolean);
  const [section, first, second, ...rest] = segments;

  if (section === 'listing' && first) {
    if (!UUID.test(first) || rest.length > 0) return notFound(request);
    const answer = await listingAnswer(first.toLowerCase(), tenantId);
    if (!answer) return null;
    if (answer.kind === 'gone') {
      return NextResponse.rewrite(new URL('/gone', request.url), {
        status: 410,
        request: { headers },
      });
    }
    if (answer.kind === 'missing') return notFound(request);

    const canonical = listingPath(first.toLowerCase(), answer.title);
    if (answer.tenantId !== tenantId) {
      return NextResponse.redirect(`${tenantOrigin(request, answer.tenantSlug)}${canonical}`, 308);
    }
    let slug: string | undefined;
    try {
      slug = second === undefined ? undefined : decodeURIComponent(second).normalize('NFC');
    } catch {
      slug = undefined;
    }
    if (slug !== listingSlug(answer.title) || first !== first.toLowerCase()) {
      return NextResponse.redirect(`${visitorOrigin(request)}${canonical}`, 308);
    }
    return null;
  }

  if (section === 'category' && first && !second) {
    if (!SLUG.test(first)) return notFound(request);
    return (await categoryExists(first, tenantId)) === false ? notFound(request) : null;
  }

  if (section === 'category' && first && second) {
    if (!SLUG.test(first) || !SLUG.test(second) || rest.length > 0) return notFound(request);
    return (await areaPageExists(first, second, tenantId)) === false ? notFound(request) : null;
  }

  if (section === 'store' && first && !second) {
    if (!SLUG.test(first)) return notFound(request);
    return (await storeExists(first, tenantId)) === false ? notFound(request) : null;
  }

  return null;
}
