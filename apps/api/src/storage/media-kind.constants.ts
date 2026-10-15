import type { StorageBucket } from './storage.ports';

export const MEDIA_KINDS = [
  'image',
  'video',
  'document',
  'import',
  'chat_image',
  'verification_image',
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * What POST /media/presign takes. A chat image is uploaded only through its
 * conversation (POST /conversations/:id/images, ADR 058), so it lands in the
 * conversation's tenant and is attached nowhere else.
 */
export const PRESIGNABLE_MEDIA_KINDS = ['image', 'video', 'document', 'import'] as const;

/** Kinds the worker treats as photos: re-encoded without metadata, with WebP variants. */
export function isImageKind(kind: MediaKind): boolean {
  return kind === 'image' || kind === 'chat_image' || kind === 'verification_image';
}

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
  // A photo sent in a chat (ADR 058): private, shown to the conversation's
  // participants through short-lived signed URLs only.
  chat_image: {
    bucket: 'documents',
    visibilityCode: 'private',
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  // A verification photo (ADR 062) — a selfie, a shop front, a licence: private,
  // re-encoded without metadata (GPS gone) like any photo, uploaded only
  // through the verification endpoints, shown to moderators through
  // short-lived signed URLs only, deleted after verification_doc_retention_days.
  verification_image: {
    bucket: 'documents',
    visibilityCode: 'private',
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  // A bulk-import sheet or image ZIP (ADR 056): never shown, only read by the import job.
  import: {
    bucket: 'documents',
    visibilityCode: 'private',
    allowedContentTypes: [
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'application/x-zip-compressed',
    ],
  },
};
