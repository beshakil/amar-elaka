import base from '@amar-elaka/config/eslint';

export default [
  ...base,
  {
    ignores: ['src/types.generated.ts'],
  },
];
