import base from '@amar-elaka/config/eslint';

export default [...base, { ignores: ['playwright-report/**', 'test-results/**'] }];
