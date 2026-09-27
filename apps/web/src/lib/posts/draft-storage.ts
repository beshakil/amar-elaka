import type { PostDraft } from './draft';

/**
 * Drafts in the browser's localStorage, one per area and per post (or "new").
 * Every access is guarded: storage can be full, disabled (private mode) or
 * hold something from an older version — then the editor simply starts
 * fresh rather than failing.
 */
export function draftKey(tenantId: string, postId: string | null): string {
  return `ae-post-draft:${tenantId}:${postId ?? 'new'}`;
}

export function loadDraft(
  key: string,
  storage: Storage | undefined = globalThis.localStorage,
): PostDraft | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(
  key: string,
  draft: PostDraft,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(key, JSON.stringify(draft));
  } catch {
    // Full or disabled: the editor keeps working, only the safety net is gone.
  }
}

export function clearDraft(
  key: string,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

function isDraft(value: unknown): value is PostDraft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.idempotencyKey === 'string' &&
    typeof d.title === 'string' &&
    typeof d.description === 'string' &&
    typeof d.formState === 'object' &&
    Array.isArray(d.existingMedia) &&
    typeof d.contactName === 'string' &&
    typeof d.contactPhone === 'string'
  );
}
