import { describe, expect, it } from 'vitest';
import { hasGrant } from '../auth/me';
import { visibleNav } from './nav';

const tenantAdmin = { isPlatformAdmin: false, grants: [{ module: '*', action: '*' }] };
const moderator = { isPlatformAdmin: false, grants: [{ module: 'posts', action: 'read' }] };
const platformAdmin = { isPlatformAdmin: true, grants: [] };

describe('hasGrant', () => {
  it('matches an exact module and action', () => {
    expect(hasGrant(moderator, { module: 'posts', action: 'read' })).toBe(true);
    expect(hasGrant(moderator, { module: 'posts', action: 'write' })).toBe(false);
  });

  it("honours the API's wildcards on either side", () => {
    expect(hasGrant(tenantAdmin, { module: 'roles', action: 'delete' })).toBe(true);
    const anyPostAction = { isPlatformAdmin: false, grants: [{ module: 'posts', action: '*' }] };
    expect(hasGrant(anyPostAction, { module: 'posts', action: 'approve' })).toBe(true);
    expect(hasGrant(anyPostAction, { module: 'roles', action: 'read' })).toBe(false);
  });

  it('lets a platform admin through regardless of grants', () => {
    expect(hasGrant(platformAdmin, { module: 'roles', action: 'write' })).toBe(true);
  });
});

describe('visibleNav', () => {
  const keys = (items: { key: string }[]) => items.map((item) => item.key);

  it('gives a tenant admin the tenant set', () => {
    expect(keys(visibleNav(tenantAdmin))).toEqual(['overview', 'roles']);
  });

  it('hides items whose grant the viewer lacks', () => {
    expect(keys(visibleNav(moderator))).toEqual(['overview']);
  });

  it('gives a platform admin the platform set', () => {
    expect(keys(visibleNav(platformAdmin))).toEqual(['overview', 'tenants', 'roles']);
  });
});
