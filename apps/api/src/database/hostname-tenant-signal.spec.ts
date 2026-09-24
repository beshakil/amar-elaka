import { rootDomainSuffixOf, tenantSignalFromHostname } from './hostname-tenant-signal';

const SUFFIX = rootDomainSuffixOf('amarelaka.local');

describe('tenantSignalFromHostname', () => {
  it('reads a single subdomain label under the root domain as a slug', () => {
    expect(tenantSignalFromHostname('mirpur.amarelaka.local', SUFFIX)).toEqual({
      kind: 'slug',
      slug: 'mirpur',
    });
  });

  it('strips a port before reading the label', () => {
    expect(tenantSignalFromHostname('mirpur.amarelaka.local:3001', SUFFIX)).toEqual({
      kind: 'slug',
      slug: 'mirpur',
    });
  });

  it('lowercases the hostname', () => {
    expect(tenantSignalFromHostname('MirPur.AmarElaka.Local', SUFFIX)).toEqual({
      kind: 'slug',
      slug: 'mirpur',
    });
  });

  it('is unusable for a multi-label host under the root domain, never a custom domain', () => {
    expect(tenantSignalFromHostname('a.b.amarelaka.local', SUFFIX)).toEqual({ kind: 'unusable' });
  });

  it('is unusable for a label that breaks the slug constraint', () => {
    expect(tenantSignalFromHostname('mirpur_1.amarelaka.local', SUFFIX)).toEqual({
      kind: 'unusable',
    });
    expect(tenantSignalFromHostname('x.amarelaka.local', SUFFIX)).toEqual({ kind: 'unusable' });
  });

  it('treats the bare root domain as a custom domain, not an empty slug', () => {
    expect(tenantSignalFromHostname('amarelaka.local', SUFFIX)).toEqual({
      kind: 'custom_domain',
      domain: 'amarelaka.local',
    });
  });

  it('reads any host outside the root domain as a custom domain', () => {
    expect(tenantSignalFromHostname('mirpur-bazaar.com', SUFFIX)).toEqual({
      kind: 'custom_domain',
      domain: 'mirpur-bazaar.com',
    });
  });

  it('is absent when there is no host at all', () => {
    expect(tenantSignalFromHostname(undefined, SUFFIX)).toEqual({ kind: 'absent' });
    expect(tenantSignalFromHostname('', SUFFIX)).toEqual({ kind: 'absent' });
  });

  it('works with a bare single-label root domain, which is how *.localhost dev works', () => {
    const localhost = rootDomainSuffixOf('localhost');
    expect(tenantSignalFromHostname('mirpur.localhost:3001', localhost)).toEqual({
      kind: 'slug',
      slug: 'mirpur',
    });
  });
});
