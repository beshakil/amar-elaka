import { describe, expect, it } from 'vitest';
import { buildBreadcrumbs } from './breadcrumbs';

describe('buildBreadcrumbs', () => {
  it('is just the overview at the root, marked current', () => {
    expect(buildBreadcrumbs('/')).toEqual([{ key: 'overview', href: '/', isCurrent: true }]);
  });

  it('builds one crumb per segment with cumulative hrefs, the last one current', () => {
    expect(buildBreadcrumbs('/roles/abc')).toEqual([
      { key: 'overview', href: '/', isCurrent: false },
      { key: 'roles', href: '/roles', isCurrent: false },
      { key: 'abc', href: '/roles/abc', isCurrent: true },
    ]);
  });

  it('ignores a trailing slash', () => {
    expect(buildBreadcrumbs('/roles/').map((crumb) => crumb.href)).toEqual(['/', '/roles']);
  });
});
