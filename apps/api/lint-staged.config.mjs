import { lintStagedFor } from '@amar-elaka/config/lint-staged';

export default lintStagedFor(import.meta.url, { eslint: ['src/', 'test/'] });
