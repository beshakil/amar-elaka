/** Visible breadcrumbs matching the BreadcrumbList JSON-LD. */
export function Breadcrumbs({ items }: { items: { name: string; path: string }[] }) {
  return (
    <nav aria-label="breadcrumb" className="mb-4 text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, index) => (
          <li key={item.path} className="flex items-center gap-1">
            {index > 0 && <span aria-hidden>›</span>}
            {index === items.length - 1 ? (
              <span aria-current="page" className="line-clamp-1 text-foreground">
                {item.name}
              </span>
            ) : (
              <a href={item.path} className="hover:underline">
                {item.name}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
