import type { Route } from 'next';
import type { EffectivePermissions } from '../api/schemas';
import { hasGrant } from '../auth/me';

export interface NavItem {
  /** Key into the `nav` message catalog — no label is hardcoded here. */
  key: string;
  href: Route;
  icon: 'dashboard' | 'shield' | 'users' | 'building';
  /** Omitted for items every member of that nav set may see. */
  requires?: { module: string; action: string };
}

/**
 * Two nav sets, picked by `isPlatformAdmin`. Only modules the API actually
 * serves appear: there is no entry here for a dashboard that has no endpoint
 * behind it yet.
 */
export const TENANT_ADMIN_NAV: NavItem[] = [
  { key: 'overview', href: '/', icon: 'dashboard' },
  { key: 'roles', href: '/roles', icon: 'shield', requires: { module: 'roles', action: 'read' } },
];

export const PLATFORM_ADMIN_NAV: NavItem[] = [
  { key: 'overview', href: '/', icon: 'dashboard' },
  { key: 'tenants', href: '/tenants', icon: 'building' },
  { key: 'roles', href: '/roles', icon: 'shield', requires: { module: 'roles', action: 'read' } },
];

export function visibleNav(permissions: EffectivePermissions): NavItem[] {
  const items = permissions.isPlatformAdmin ? PLATFORM_ADMIN_NAV : TENANT_ADMIN_NAV;
  return items.filter((item) => !item.requires || hasGrant(permissions, item.requires));
}
