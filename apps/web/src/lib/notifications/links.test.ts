import { describe, expect, it } from 'vitest';
import { webPathForDeepLink } from './links';
import { notificationTypeGroup } from './labels';

describe('where a notification or web push leads', () => {
  it('the exact page for what the site has', () => {
    expect(webPathForDeepLink('/chat/0192a000-0000-7000-8000-000000000001')).toBe(
      '/inbox/0192a000-0000-7000-8000-000000000001',
    );
    expect(webPathForDeepLink('/chat')).toBe('/inbox');
    expect(webPathForDeepLink('/posts/p1?action=repost')).toBe('/listing/p1');
    expect(webPathForDeepLink('/stores/s1/imports/i1')).toBe('/seller/s1/import');
    expect(webPathForDeepLink('/saved-searches/x')).toBe('/search');
  });
  it('nothing for the rest — and never somewhere off the site', () => {
    expect(webPathForDeepLink(null)).toBeNull();
    expect(webPathForDeepLink('//evil.example/chat')).toBeNull();
    expect(webPathForDeepLink('https://evil.example')).toBeNull();
    expect(webPathForDeepLink('/chat/../../admin')).toBeNull();
    expect(webPathForDeepLink('/places/p1')).toBeNull();
  });
});

describe('settings groups', () => {
  it('related types share a line, as in the app', () => {
    expect(notificationTypeGroup('post_approved')).toBe('post_outcome');
    expect(notificationTypeGroup('post_removed')).toBe('post_outcome');
    expect(notificationTypeGroup('new_message')).toBe('new_message');
    expect(notificationTypeGroup('brand_new_type')).toBe('other');
  });
});
