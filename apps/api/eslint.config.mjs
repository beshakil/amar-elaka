import base from '@amar-elaka/config/eslint';

export default [
  ...base,
  {
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
