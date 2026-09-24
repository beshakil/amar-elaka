import nextPlugin from '@next/eslint-plugin-next';
import base from '@amar-elaka/config/eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  ...base,
  reactHooks.configs.flat.recommended,
  {
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    // Server Components and Route Handlers are async by design; the typed
    // fetch client returns `unknown`-shaped JSON that we narrow ourselves.
    files: ['src/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    ignores: ['.next/**', 'next-env.d.ts'],
  },
];
