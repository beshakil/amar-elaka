import { getRequestConfig } from 'next-intl/server';

/**
 * Bengali only, same as the public site: operators are local partners, and
 * CLAUDE.md rule 6 applies to dashboards too. A second catalog plus a switcher
 * is additive whenever it is wanted.
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
