import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Every package's `lint` script covers TypeScript only, so this does too.
const LINTED = /\.tsx?$/;
const quote = (file) => JSON.stringify(file);

/**
 * Per-package lint-staged config for this monorepo.
 *
 * lint-staged runs each package's config with that package as the working
 * directory, which is what lets ESLint 9 find the package's own
 * eslint.config.* — there is deliberately no root ESLint config. ESLint only
 * gets the files the package's `lint` script covers (the ones its tsconfig
 * includes, which typed linting needs); every staged file is formatted.
 *
 * Usage, in <package>/lint-staged.config.mjs:
 *   export default lintStagedFor(import.meta.url, { eslint: ['src/', 'test/'] });
 *
 * @param {string} configUrl  `import.meta.url` of the package's config file
 * @param {{ eslint: string[], eslintTopLevel?: boolean }} options
 *   `eslint`: directories (relative, trailing slash) whose scripts are linted;
 *   `eslintTopLevel`: also lint scripts directly in the package root.
 */
export function lintStagedFor(configUrl, { eslint, eslintTopLevel = false }) {
  const packageDir = dirname(fileURLToPath(configUrl));

  const isLinted = (file) => {
    if (!LINTED.test(file)) return false;
    const path = relative(packageDir, file).split(sep).join('/');
    if (eslintTopLevel && !path.includes('/')) return true;
    return eslint.some((dir) => path.startsWith(dir));
  };

  return {
    '*': (files) => {
      const linted = files.filter(isLinted);
      return [
        ...(linted.length > 0 ? [`eslint --fix ${linted.map(quote).join(' ')}`] : []),
        // Prettier reads ignore files from its working directory only, so the
        // repository's are passed explicitly (generated files like
        // openapi.json must never be reformatted).
        `prettier --write --ignore-unknown --ignore-path ${quote(join(REPO_ROOT, '.gitignore'))} --ignore-path ${quote(join(REPO_ROOT, '.prettierignore'))} ${files.map(quote).join(' ')}`,
      ];
    },
  };
}
