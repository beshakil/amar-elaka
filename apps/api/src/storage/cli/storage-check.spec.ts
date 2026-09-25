jest.mock('../../config/env', () => ({ env: {} }));

import { parseOrigins } from './storage-check';

describe('storage:check --origin parsing', () => {
  it('accepts both --origin forms and repeats', () => {
    expect(
      parseOrigins(['--origin', 'https://savar.amarelaka.com', '--origin=http://localhost:3001']),
    ).toEqual(['https://savar.amarelaka.com', 'http://localhost:3001']);
  });

  it('checks nothing without --origin', () => {
    expect(parseOrigins([])).toEqual([]);
  });

  it('rejects a URL with a path, which is not an origin', () => {
    expect(() => parseOrigins(['--origin', 'https://savar.amarelaka.com/listing'])).toThrow(
      /origin/,
    );
  });
});
