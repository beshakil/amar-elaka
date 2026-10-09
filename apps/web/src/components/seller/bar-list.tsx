import { localizeDigits } from '@amar-elaka/dynamic-form';

/** Horizontal bars with their numbers written out: readable without the bars (ADR 057). */
export function BarList({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label} className="grid grid-cols-[6rem_1fr_3rem] items-center gap-3 text-sm">
          <span>{item.label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span
              className="block h-full rounded-full bg-brand"
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums">
            {localizeDigits(String(item.value), 'bn')}
          </span>
        </li>
      ))}
    </ul>
  );
}
