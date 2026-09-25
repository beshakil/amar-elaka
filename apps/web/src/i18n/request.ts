import { getRequestConfig } from 'next-intl/server';

/**
 * Bengali is the product's default and, for now, its only locale — there is no
 * locale-prefixed routing yet. Messages still go through next-intl so no
 * user-facing string is hardcoded in a component (CLAUDE.md rule 6), and
 * adding `en.json` plus a switcher later is additive.
 */
export const defaultLocale = 'bn';

export default getRequestConfig(async () => ({
  locale: defaultLocale,
  messages: {
    ...(await import('../messages/bn.json')).default,
    // `dynamicForm.*`: the shared category form/filter renderer's own strings.
    ...(await import('@amar-elaka/dynamic-form/messages/bn.json')).default,
  },
}));
