import { describe, expect, it } from 'vitest';
import { editorTenant } from './editor-tenant';

const base = { id: 't1', nameBn: 'মিরপুর', mapCenter: { lat: 23.81, lng: 90.36 } };

describe('editorTenant', () => {
  it("takes the photo limits from the tenant's config (post_max_media, media_variant_full_px)", () => {
    const tenant = editorTenant({
      ...base,
      moderation: { typicalReviewHours: 6 },
      media: { postMaxPhotos: 6, imageMaxLongEdgePx: 1600 },
    });
    expect(tenant).toMatchObject({ typicalReviewHours: 6, maxPhotos: 6, imageMaxLongEdgePx: 1600 });
  });

  it('falls back to the seeded defaults for a config from an older API', () => {
    expect(editorTenant(base)).toMatchObject({
      typicalReviewHours: 12,
      maxPhotos: 10,
      imageMaxLongEdgePx: 1200,
    });
  });
});
