export interface Crumb {
  /** Message key under `breadcrumb`, falling back to the raw segment. */
  key: string;
  href: string;
  isCurrent: boolean;
}

/**
 * Derives the trail from the pathname alone, so no page has to declare its own
 * breadcrumbs. Pure, and the only piece of the shell worth a unit test.
 */
export function buildBreadcrumbs(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean);
  const crumbs: Crumb[] = [{ key: 'overview', href: '/', isCurrent: segments.length === 0 }];

  let href = '';
  segments.forEach((segment, index) => {
    href += `/${segment}`;
    crumbs.push({ key: segment, href, isCurrent: index === segments.length - 1 });
  });

  return crumbs;
}
