'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { SuggestResponse } from '@/lib/api/schemas';
import { listingPath } from '@/lib/seo/slug';

export interface SearchBoxLabels {
  placeholder: string;
  submit: string;
  categories: string;
  queries: string;
  listings: string;
  /** "{count}টি পরামর্শ" for screen readers (a template: props cross from server to client). */
  announce: string;
}

interface Option {
  id: string;
  label: string;
  href: string;
  group: 'categories' | 'queries' | 'listings';
}

// Long enough to skip the keystrokes of one word, short enough to feel live
// (the same pause as the app's search bar).
const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

/**
 * The header's search box with as-you-type suggestions (ADR 042).
 *
 * Without JavaScript it is a plain GET form to /search. With it, typing
 * pauses → one request to /api/search/suggest (the answer to older text is
 * dropped), shown as an ARIA combobox: ↑/↓ move, Enter opens the chosen
 * suggestion (or searches the text), Esc closes. Bengali IMEs are left
 * alone: the text is never rewritten while typing.
 */
export function SearchBox({ labels }: { labels: SearchBoxLabels }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initial = pathname === '/search' ? (searchParams.get('q') ?? '') : '';
  const [text, setText] = useState(initial);
  // A new search page (back/forward too) shows its own text: adjusted while
  // rendering, the React way for state that follows a prop.
  const [shownInitial, setShownInitial] = useState(initial);
  if (initial !== shownInitial) {
    setShownInitial(initial);
    setText(initial);
  }
  const [answer, setAnswer] = useState<{ q: string; options: Option[] }>({ q: '', options: [] });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const latest = useRef('');
  const root = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const q = text.trim();
    latest.current = q;
    if ([...q].length < MIN_CHARS) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!response.ok || latest.current !== q) return;
        const body = (await response.json()) as SuggestResponse;
        setAnswer({ q, options: toOptions(body) });
        setActive(-1);
      } catch {
        // Suggestions are a convenience; the form still searches.
      }
    };
    const timer = setTimeout(() => void load(), DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Too short to suggest: nothing, whatever the last answer was.
  const options = [...text.trim()].length >= MIN_CHARS ? answer.options : [];
  const expanded = open && options.length > 0;
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return; // an IME's own Enter/arrows
    if (event.key === 'ArrowDown' && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === 'ArrowUp' && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    } else if (event.key === 'Enter' && expanded && active >= 0) {
      event.preventDefault();
      window.location.assign(options[active]!.href);
    }
  };

  const groups = (['categories', 'queries', 'listings'] as const).filter((g) =>
    options.some((o) => o.group === g),
  );

  return (
    <form
      ref={root}
      action="/search"
      method="get"
      role="search"
      className="order-last flex min-w-0 flex-1 items-center gap-2 sm:order-none"
    >
      <div className="relative w-full">
        <Input
          name="q"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
          className="pr-10"
        />
        <button
          type="submit"
          aria-label={labels.submit}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <Search className="size-4" aria-hidden />
        </button>
        <p className="sr-only" role="status" aria-live="polite">
          {expanded
            ? labels.announce.replace('{count}', localizeDigits(String(options.length), 'bn'))
            : ''}
        </p>
        <ul
          id={listId}
          role="listbox"
          aria-label={labels.placeholder}
          hidden={!expanded}
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-96 overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
        >
          {groups.map((group) => (
            <li key={group} role="presentation">
              <p className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground">
                {labels[group]}
              </p>
              <ul role="presentation">
                {options.map((option, index) =>
                  option.group !== group ? null : (
                    <li
                      key={option.id}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === active}
                      className={index === active ? 'bg-muted' : 'hover:bg-muted'}
                    >
                      <a href={option.href} className="block truncate px-3 py-2 text-sm">
                        {option.label}
                      </a>
                    </li>
                  ),
                )}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}

function toOptions(body: SuggestResponse): Option[] {
  return [
    ...body.categories.map((c) => ({
      id: `c-${c.slug}`,
      label: c.name.bn ?? c.name.en ?? c.slug,
      href: `/category/${c.slug}`,
      group: 'categories' as const,
    })),
    ...body.queries.map((q) => ({
      id: `q-${q.query}`,
      label: q.query,
      href: `/search?q=${encodeURIComponent(q.query)}`,
      group: 'queries' as const,
    })),
    ...body.listings.map((l) => {
      const title = l.title.bn ?? l.title.en ?? '';
      return {
        id: `l-${l.id}`,
        label: title,
        href: listingPath(l.id, title),
        group: 'listings' as const,
      };
    }),
  ];
}
