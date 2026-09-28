import { localizeDigits } from '@amar-elaka/dynamic-form';

/** Links to a category's area pages, with each one's count: crawlable internal links. */
export function AreaLinks({
  slug,
  items,
}: {
  slug: string;
  items: { area: { slug: string; name: { bn: string } }; count: number }[];
}) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item.area.slug}>
          <a
            href={`/category/${slug}/${item.area.slug}`}
            className="inline-block rounded-full border border-border px-3 py-1 text-sm hover:bg-muted"
          >
            {item.area.name.bn} ({localizeDigits(String(item.count), 'bn')})
          </a>
        </li>
      ))}
    </ul>
  );
}
