import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface SaveSearchLabels {
  save: string;
  title: string;
  name: string;
  frequency: string;
  frequencies: Record<'instant' | 'daily' | 'off', string>;
  submit: string;
  login: string;
}

/**
 * "Save this search" (ADR 041/042). A plain POST form to this app's own
 * /api/saved-searches, which answers with a redirect back here (post →
 * redirect → get): works without JavaScript, and the back button never
 * resubmits it. A guest gets a login link that comes back to this search.
 */
export function SaveSearch({
  signedIn,
  searchPath,
  defaultName,
  radiusKm,
  labels,
}: {
  signedIn: boolean;
  /** The search's own URL (path + query), to come back to. */
  searchPath: string;
  defaultName: string;
  radiusKm: number | null;
  labels: SaveSearchLabels;
}) {
  if (!signedIn) {
    return (
      <a
        href={`/login?next=${encodeURIComponent(searchPath)}`}
        rel="nofollow"
        className="inline-flex items-center gap-2 text-sm text-brand hover:underline"
      >
        <BellRing className="size-4" aria-hidden />
        {labels.login}
      </a>
    );
  }
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-brand">
        <BellRing className="size-4" aria-hidden />
        {labels.save}
      </summary>
      <form method="post" action="/api/saved-searches" className="mt-3 space-y-3">
        <input type="hidden" name="return" value={searchPath} />
        {radiusKm !== null && <input type="hidden" name="radius_km" value={radiusKm} />}
        <label className="block space-y-1 text-sm">
          <span>{labels.name}</span>
          <Input name="name" defaultValue={defaultName} required maxLength={80} />
        </label>
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1">{labels.frequency}</legend>
          {(['instant', 'daily', 'off'] as const).map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="frequency"
                value={value}
                defaultChecked={value === 'daily'}
              />
              {labels.frequencies[value]}
            </label>
          ))}
        </fieldset>
        <Button type="submit">{labels.submit}</Button>
      </form>
    </details>
  );
}
