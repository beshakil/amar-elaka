import type { FormState } from '@amar-elaka/dynamic-form';

/**
 * What the post editor holds while a seller writes (web). Saved to the
 * browser (draft-storage.ts) on every change, so a closed tab or a reload
 * loses nothing typed. Photos are the exception: a File can't be stored, so
 * uploaded ones are kept by id (existingMedia) and in-flight ones are lost.
 */
export interface PostDraft {
  /** Sent as Idempotency-Key: a retried submit can't post twice. */
  idempotencyKey: string;
  categoryId: string | null;
  title: string;
  description: string;
  formState: FormState;
  /** Photos already attached/uploaded, in order (edit: the post's own). */
  existingMedia: { id: string; thumbUrl: string | null }[];
  location: { lat: number; lng: number } | null;
  addressLabel: string | null;
  contactName: string;
  /** As typed; normalized to E.164 when sent. */
  contactPhone: string;
  showPhone: boolean;
  allowChat: boolean;
  showWhatsapp: boolean;
}

export function emptyDraft(
  contact: { name: string; phone: string },
  newKey: () => string,
): PostDraft {
  return {
    idempotencyKey: `post-${newKey()}`,
    categoryId: null,
    title: '',
    description: '',
    formState: {},
    existingMedia: [],
    location: null,
    addressLabel: null,
    contactName: contact.name,
    contactPhone: localPhone(contact.phone),
    showPhone: true,
    allowChat: true,
    showWhatsapp: false,
  };
}

/** +8801712345678 → 01712345678 (what a Bangladeshi types and reads). */
export function localPhone(e164: string): string {
  return e164.replace(/^\+88/, '');
}

const BD_MOBILE = /^(?:\+?880|0)(1[3-9]\d{8})$/;

/** Either script, any spacing → +8801XXXXXXXXX, or null if not a BD mobile number. */
export function toE164(input: string): string | null {
  const latin = input.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  const compact = latin.trim().replace(/[\s-]/g, '');
  const match = BD_MOBILE.exec(compact);
  return match ? `+880${match[1]}` : null;
}
