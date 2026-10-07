import type { Route } from 'next';
import type { EffectivePermissions } from '../api/schemas';
import { hasGrant } from '../auth/me';

export interface NavItem {
  /** Key into the `nav` message catalog — no label is hardcoded here. */
  key: string;
  href: Route;
  icon: 'dashboard' | 'shield' | 'users' | 'building' | 'flag' | 'map';
  /** Omitted for items every member of that nav set may see. */
  requires?: { module: string; action: string };
  /** Any one of these grants is enough (a section with several queues). */
  requiresAny?: readonly { module: string; action: string }[];
  /** Also only these roles (a grant other roles share, but a report they may not read). */
  roles?: readonly string[];
}

/**
 * Two nav sets, picked by `isPlatformAdmin`. Only modules the API actually
 * serves appear: there is no entry here for a dashboard that has no endpoint
 * behind it yet.
 */
export const TENANT_ADMIN_NAV: NavItem[] = [
  { key: 'overview', href: '/', icon: 'dashboard' },
  {
    key: 'moderation',
    href: '/moderation',
    icon: 'flag',
    requiresAny: [
      { module: 'posts', action: 'approve' },
      { module: 'places', action: 'approve' },
    ],
  },
  {
    key: 'heatmap',
    href: '/heatmap',
    icon: 'map',
    requires: { module: 'analytics', action: 'read' },
    roles: ['tenant_admin', 'partner_owner'],
  },
  { key: 'roles', href: '/roles', icon: 'shield', requires: { module: 'roles', action: 'read' } },
];

export const PLATFORM_ADMIN_NAV: NavItem[] = [
  { key: 'overview', href: '/', icon: 'dashboard' },
  { key: 'tenants', href: '/tenants', icon: 'building' },
  { key: 'roles', href: '/roles', icon: 'shield', requires: { module: 'roles', action: 'read' } },
];

export function visibleNav(permissions: EffectivePermissions): NavItem[] {
  const items = permissions.isPlatformAdmin ? PLATFORM_ADMIN_NAV : TENANT_ADMIN_NAV;
  return items.filter(
    (item) =>
      (!item.requires || hasGrant(permissions, item.requires)) &&
      (!item.requiresAny || item.requiresAny.some((grant) => hasGrant(permissions, grant))) &&
      (!item.roles || item.roles.includes(permissions.role ?? '')),
  );
}
