import type { Route } from 'next';

/**
 * The site page for a notification's deep link (the API's `deepLink`, the
 * same in the bell, the notification page and a web push — ADR 059/060), or
 * null when the site has no page for it. The app's twin is
 * apps/mobile/lib/core/routing/deep_links.dart.
 *
 *   /chat, /chat/<id>        the inbox, a conversation
 *   /posts/<id>              the listing (its canonical URL is a redirect away)
 *   /stores/<id>/imports/<x> the seller panel's import page
 *   /saved-searches[/<id>]   the search page (saved searches live in the app)
 */
export function webPathForDeepLink(link: string | null | undefined): Route | null {
  if (!link || !link.startsWith('/') || link.startsWith('//')) return null;
  const [path] = link.split('?');
  const parts = (path ?? '').split('/').filter(Boolean);
  const [head, id, sub, subId] = parts;
  const safe = (v: string | undefined) => v !== undefined && /^[A-Za-z0-9_-]+$/.test(v);
  switch (head) {
    case 'chat':
      if (parts.length === 1) return '/inbox';
      return parts.length === 2 && safe(id) ? (`/inbox/${id}` as Route) : null;
    case 'posts':
      return parts.length === 2 && safe(id) ? (`/listing/${id}` as Route) : null;
    case 'stores':
      return parts.length === 4 && safe(id) && sub === 'imports' && safe(subId)
        ? (`/seller/${id}/import` as Route)
        : null;
    case 'saved-searches':
      return '/search';
    default:
      return null;
  }
}
