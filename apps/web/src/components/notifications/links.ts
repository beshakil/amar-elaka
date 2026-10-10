import type { NotificationItem } from '@/lib/api/schemas';

/** A notification's link: through /notifications/open (marked read, then its exact page). */
export function openHref(item: Pick<NotificationItem, 'id' | 'deepLink'>): string {
  const params = new URLSearchParams({ id: item.id });
  if (item.deepLink) params.set('link', item.deepLink);
  return `/notifications/open?${params.toString()}`;
}
