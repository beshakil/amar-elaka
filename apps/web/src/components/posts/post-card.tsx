import { ImageOff } from 'lucide-react';
import type { ReactNode } from 'react';

export interface PostCardData {
  title: string;
  /** "৳ ১৫,০০০", or null (the card says "contact for price"). */
  price: string | null;
  attributes: string[];
  place?: string | null;
  posted?: string | null;
  photoUrl?: string | null;
  isSold?: boolean;
}

/**
 * A post in a list: cover, title, price, the category's key facts, place and
 * time — the same card the preview shows, so the seller sees exactly this.
 * Labels come in as props (server and client callers translate).
 */
export function PostCard({
  data,
  labels,
  footer,
}: {
  data: PostCardData;
  labels: { priceOnRequest: string; noPhotos: string; sold: string };
  footer?: ReactNode;
}) {
  const meta = [data.place, data.posted].filter(Boolean).join(' · ');
  return (
    <article className="rounded-lg border border-border bg-card p-3">
      <div className="flex gap-3">
        <div className="relative size-28 shrink-0 overflow-hidden rounded-md bg-muted">
          {data.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
            <img src={data.photoUrl} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
              <ImageOff className="size-5" aria-hidden />
              {labels.noPhotos}
            </div>
          )}
          {data.isSold && (
            <span className="absolute inset-x-0 bottom-0 bg-foreground/80 py-0.5 text-center text-xs text-background">
              {labels.sold}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="line-clamp-2 font-semibold">{data.title || '—'}</h3>
          <p className="font-bold text-brand">{data.price ?? labels.priceOnRequest}</p>
          {data.attributes.length > 0 && (
            <p className="line-clamp-2 text-sm">{data.attributes.slice(0, 3).join(' · ')}</p>
          )}
          {meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
        </div>
      </div>
      {footer}
    </article>
  );
}
