import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shown while a page's data streams in. It is at least a screen tall, so the
 * footer starts below the fold and doesn't jump when the page replaces it
 * (a layout shift Lighthouse and Core Web Vitals count).
 */
export default function Loading() {
  return (
    <div className="min-h-svh space-y-6">
      <Skeleton className="h-9 w-2/3 max-w-sm" />
      <Skeleton className="h-5 w-full max-w-lg" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-16" />
        ))}
      </div>
    </div>
  );
}
