import type { Route } from 'next';
import type { EffectivePermissions } from '../api/schemas';
import { hasGrant } from '../auth/me';

export interface NavItem {
  /** Key into the `nav` message catalog — no label is hardcoded here. */
  key: string;
  href: Route;
  icon: 'dashboard' | 'shield' | 'users' | 'building' | 'flag' | 'map' | 'info';
  /** Omitted for items every member of that nav set may see. */
  requires?: { module: string; action: string };
  /** Any one of these grants is enough (a section with several queues). */
  requiresAny?: readonly { module: string; action: string }[];
  /** Also only these roles (a grant other roles share, but a report they may not read). */
  roles?: readonly string[];
}

/** Who works the area's local information (staff and field agents). */
export const LOCAL_INFO_ROLES = ['tenant_admin', 'partner_owner', 'moderator', 'agent'] as const;
/** Of them, who may take a blood request down or change the board and sponsor. */
export const LOCAL_INFO_STAFF_ROLES = ['tenant_admin', 'partner_owner', 'moderator'] as const;

/** Who manages field agents (reads: the area's staff; changes: its admins, checked by the API). */
export const AGENT_ADMIN_ROLES = ['tenant_admin', 'partner_owner', 'moderator'] as const;

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
      { module: 'verifications', action: 'approve' },
      { module: 'complaints', action: 'read' },
      { module: 'bans', action: 'read' },
      { module: 'appeals', action: 'read' },
      { module: 'blacklist', action: 'read' },
    ],
  },
  {
    key: 'heatmap',
    href: '/heatmap',
    icon: 'map',
    requires: { module: 'analytics', action: 'read' },
    roles: ['tenant_admin', 'partner_owner'],
  },
  // ADR 064: emergency contacts, the bazar board and blood requests — the
  // API checks the role (staff; field agents for contacts and prices).
  { key: 'localInfo', href: '/local-info', icon: 'info', roles: LOCAL_INFO_ROLES },
  // ADR 066: field agents, their submissions and the commission report (the API checks the role).
  { key: 'agents', href: '/agents', icon: 'users', roles: AGENT_ADMIN_ROLES },
  { key: 'roles', href: '/roles', icon: 'shield', requires: { module: 'roles', action: 'read' } },
];

export const PLATFORM_ADMIN_NAV: NavItem[] = [
  { key: 'overview', href: '/', icon: 'dashboard' },
  { key: 'tenants', href: '/tenants', icon: 'building' },
  // ADR 063: escalated and global appeals; blacklist recommendations to approve.
  { key: 'platformAppeals', href: '/platform/appeals', icon: 'flag' },
  { key: 'platformBlacklist', href: '/platform/blacklist', icon: 'shield' },
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
