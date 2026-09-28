import { ImageOff } from 'lucide-react';
import type { ListingCardData } from '@/lib/listings/format';

/**
 * Listing cards in a responsive grid, server-rendered as plain links (every
 * listing is a crawlable <a>). Images carry their size (no layout shift);
 * only the first row loads eagerly — it's the likely LCP on a phone.
 */
export function ListingGrid({
  cards,
  badgeLabel,
  soldLabel,
  eager = 2,
  titleLevel = 3,
}: {
  cards: ListingCardData[];
  badgeLabel: (code: string) => string | null;
  soldLabel: string;
  eager?: number;
  /** The cards' heading level: one below the section heading they sit under. */
  titleLevel?: 2 | 3;
}) {
  const Title = titleLevel === 2 ? 'h2' : 'h3';
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {cards.map((card, index) => (
        <li key={card.id}>
          <a
            href={card.href}
            className="block h-full overflow-hidden rounded-lg border border-border bg-card hover:shadow-sm"
          >
            <div className="relative aspect-[4/3] bg-muted">
              {card.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
                <img
                  src={card.imageUrl}
                  alt=""
                  width={400}
                  height={300}
                  loading={index < eager ? 'eager' : 'lazy'}
                  fetchPriority={index === 0 ? 'high' : 'auto'}
                  decoding="async"
                  className="size-full object-cover"
                />
              ) : (
                <div className="flex size-full items-center justify-center text-muted-foreground">
                  <ImageOff className="size-6" aria-hidden />
                </div>
              )}
              {card.sold && (
                <span className="absolute inset-x-0 bottom-0 bg-foreground/85 py-0.5 text-center text-xs text-background">
                  {soldLabel}
                </span>
              )}
            </div>
            <div className="space-y-1 p-2">
              <Title className="line-clamp-2 text-sm font-medium">{card.title}</Title>
              <p className="font-semibold text-brand">{card.price}</p>
              {card.meta && <p className="truncate text-xs text-muted-foreground">{card.meta}</p>}
              {card.badges.length > 0 && (
                <p className="flex flex-wrap gap-1">
                  {card.badges.map((code) => {
                    const label = badgeLabel(code);
                    return label ? (
                      <span key={code} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                        {label}
                      </span>
                    ) : null;
                  })}
                </p>
              )}
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
