import type { StorageBucket } from './storage.ports';

export type MediaKind = 'image' | 'video' | 'document';

interface MediaKindPolicy {
  bucket: StorageBucket;
  visibilityCode: 'public' | 'private';
  /** A capability list, not a business threshold (CLAUDE.md rule 9) — stays a code constant. */
  allowedContentTypes: readonly string[];
}

export const MEDIA_KIND_POLICIES: Record<MediaKind, MediaKindPolicy> = {
  image: {
    bucket: 'media',
    visibilityCode: 'public',
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  video: {
    bucket: 'media',
    visibilityCode: 'public',
    allowedContentTypes: ['video/mp4', 'video/webm'],
  },
  document: {
    bucket: 'documents',
    visibilityCode: 'private',
    allowedContentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  },
};
