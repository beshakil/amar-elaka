import { parseTypes } from './reindex';

describe('search:reindex --type', () => {
  it('defaults to every type and accepts a list in either form', () => {
    expect(parseTypes([])).toEqual(['posts', 'stores', 'places']);
    expect(parseTypes(['--type', 'posts,places'])).toEqual(['posts', 'places']);
    expect(parseTypes(['--type=stores'])).toEqual(['stores']);
  });

  it('refuses unknown types', () => {
    expect(() => parseTypes(['--type', 'posts,users'])).toThrow(/comma-separated/);
    expect(() => parseTypes(['--type'])).toThrow();
  });
});
