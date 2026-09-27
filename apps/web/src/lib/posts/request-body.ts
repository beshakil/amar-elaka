import {
  formStateToValues,
  type CategoryFieldSchema,
  type FieldValues,
} from '@amar-elaka/dynamic-form';
import { toE164, type PostDraft } from './draft';

/**
 * The API body (CreatePostDto / UpdatePostDto) for a draft: the category's
 * fields in API shape, photos in display order (kept ones, then new uploads),
 * the contact number in E.164. `fields` comes from the form's own submit when
 * there is one (already validated), else from the saved state.
 */
export function postRequestBody(
  draft: PostDraft,
  schema: CategoryFieldSchema,
  uploadedMediaIds: readonly string[],
  options: { isEdit: boolean; fields?: FieldValues },
): Record<string, unknown> {
  const description = draft.description.trim();
  const phone = toE164(draft.contactPhone);
  return {
    categoryId: draft.categoryId,
    title: draft.title.trim(),
    // Create omits an empty description; an edit clears it with null.
    ...(description ? { description } : options.isEdit ? { description: null } : {}),
    fields: options.fields ?? formStateToValues(schema.jsonSchema, draft.formState),
    location: draft.location,
    mediaIds: [...draft.existingMedia.map((m) => m.id), ...uploadedMediaIds],
    showPhone: draft.showPhone,
    allowChat: draft.allowChat,
    showWhatsapp: draft.showPhone && draft.showWhatsapp,
    ...(draft.contactName.trim() ? { contactName: draft.contactName.trim() } : {}),
    ...(phone ? { contactPhone: phone } : {}),
  };
}

export type SectionIssue =
  'category' | 'title' | 'location' | 'contactName' | 'contactPhone' | 'unreachable';

/** What the sections outside the category form still need (the form checks its own). */
export function sectionIssues(draft: PostDraft): SectionIssue[] {
  const issues: SectionIssue[] = [];
  if (!draft.categoryId) issues.push('category');
  if (!draft.title.trim()) issues.push('title');
  if (!draft.location) issues.push('location');
  if (!draft.contactName.trim()) issues.push('contactName');
  if ((draft.showPhone || draft.contactPhone.trim()) && !toE164(draft.contactPhone)) {
    issues.push('contactPhone');
  }
  if (!draft.showPhone && !draft.allowChat) issues.push('unreachable');
  return issues;
}
