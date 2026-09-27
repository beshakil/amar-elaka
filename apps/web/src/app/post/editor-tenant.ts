import type { EditorTenant } from './post-editor';

/** What the editor needs to know about the area. */
export function editorTenant(tenant: {
  id: string;
  nameBn: string;
  mapCenter: { lat: number; lng: number };
  moderation?: { typicalReviewHours: number } | undefined;
}): EditorTenant {
  return {
    id: tenant.id,
    nameBn: tenant.nameBn,
    mapCenter: tenant.mapCenter,
    // The seeded default (moderation_typical_review_hours) for an older API.
    typicalReviewHours: tenant.moderation?.typicalReviewHours ?? 12,
  };
}
