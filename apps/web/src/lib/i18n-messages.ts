import type { AbstractIntlMessages } from 'next-intl';

/**
 * Only the namespaces a page's client components read: the provider
 * serializes what it's given into the page payload, so passing the whole
 * catalog would ship all of the site's copy (as in app/layout.tsx).
 */
export function pickMessages(
  messages: AbstractIntlMessages,
  namespaces: readonly string[],
): AbstractIntlMessages {
  return Object.fromEntries(
    Object.entries(messages).filter(([namespace]) => namespaces.includes(namespace)),
  );
}
