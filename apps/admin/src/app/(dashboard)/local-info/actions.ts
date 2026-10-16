'use server';

import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { apiErrorMessageKey } from '@/lib/api/error-messages';
import { apiFetch } from '@/lib/api/fetch';
import {
  createdIdSchema,
  infoCreatedSchema,
  infoDecidedSchema,
  noContentSchema,
  publishedSchema,
  savedCountSchema,
} from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';

// Mirrors the API's info DTOs (apps/api/src/info/dto/info.dto.ts and
// apps/api/src/info-engine/dto/info-engine.dto.ts) so the
// client refuses what the server would; the API checks everything again.
const id = z.string().uuid();
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const contact = z.object({
  serviceType: z.string().regex(/^[a-z][a-z0-9_]*$/),
  nameBn: z.string().trim().min(1),
  nameEn: z.string().trim().nullable(),
  phones: z.array(z.string().regex(/^\+?[0-9]{3,15}$/)).min(1),
  address: z.string().trim().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  is24h: z.boolean(),
  availabilityNote: z.string().trim().nullable(),
  sortOrder: z.number().int().min(0),
  isActive: z.boolean(),
});
export type ContactInput = z.infer<typeof contact>;

const entry = z.object({
  date: isoDate,
  items: z
    .array(z.object({ commodityId: id, unitCode: z.string(), minPrice: money, maxPrice: money }))
    .min(1),
});
export type EntryInput = z.infer<typeof entry>;

const catalogue = z.object({
  items: z.array(z.object({ commodityId: id, unitCode: z.string(), sortOrder: z.number().int() })),
});
export type CatalogueInput = z.infer<typeof catalogue>;

const sponsor = z.object({
  nameBn: z.string().trim().min(1),
  nameEn: z.string().trim().nullable(),
  taglineBn: z.string().trim().nullable(),
  linkUrl: z.string().url().startsWith('https://').nullable(),
  startsOn: isoDate,
  endsOn: isoDate.nullable(),
});
export type SponsorInput = z.infer<typeof sponsor>;

const removal = z.object({
  reasonCode: z.enum(['fake_blood_request', 'blood_request_abuse']),
  reasonText: z.string().trim().min(3),
});
export type RemovalInput = z.infer<typeof removal>;

async function call(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  schema: z.ZodTypeAny,
): Promise<ActionResult> {
  // Tokens live in httpOnly cookies: only the server can attach them.
  const session = await readSession();
  if (!session) return { ok: false, messageKey: 'unauthenticated' };
  try {
    await apiFetch({
      path,
      method,
      schema,
      tenantId: session.tenantId,
      accessToken: session.accessToken,
      ...(body === undefined ? {} : { body }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, messageKey: apiErrorMessageKey(error) };
  }
}

const invalid: ActionResult = { ok: false, messageKey: 'validationFailed' };

export async function saveContact(
  contactId: string | null,
  input: ContactInput,
): Promise<ActionResult> {
  const parsed = contact.safeParse(input);
  if (!parsed.success || (contactId !== null && !id.safeParse(contactId).success)) return invalid;
  return contactId === null
    ? call('/info/emergency/contacts', 'POST', parsed.data, createdIdSchema)
    : call(`/info/emergency/contacts/${contactId}`, 'PUT', parsed.data, noContentSchema);
}

export async function verifyContact(contactId: string): Promise<ActionResult> {
  if (!id.safeParse(contactId).success) return invalid;
  return call(`/info/emergency/contacts/${contactId}/verify`, 'POST', undefined, noContentSchema);
}

export async function deleteContact(contactId: string): Promise<ActionResult> {
  if (!id.safeParse(contactId).success) return invalid;
  return call(`/info/emergency/contacts/${contactId}`, 'DELETE', undefined, noContentSchema);
}

export async function saveEntry(input: EntryInput): Promise<ActionResult> {
  const parsed = entry.safeParse(input);
  if (!parsed.success) return invalid;
  return call('/bazar/entry', 'PUT', parsed.data, savedCountSchema);
}

export async function saveCatalogue(input: CatalogueInput): Promise<ActionResult> {
  const parsed = catalogue.safeParse(input);
  if (!parsed.success) return invalid;
  return call('/bazar/catalogue', 'PUT', parsed.data, noContentSchema);
}

export async function saveSponsor(input: SponsorInput | null): Promise<ActionResult> {
  if (input === null) return call('/bazar/sponsor', 'DELETE', undefined, noContentSchema);
  const parsed = sponsor.safeParse(input);
  if (!parsed.success) return invalid;
  return call('/bazar/sponsor', 'PUT', parsed.data, noContentSchema);
}

export async function removeBloodRequest(
  requestId: string,
  input: RemovalInput,
): Promise<ActionResult> {
  const parsed = removal.safeParse(input);
  if (!parsed.success || !id.safeParse(requestId).success) return invalid;
  return call(`/blood/requests/${requestId}/remove`, 'POST', parsed.data, noContentSchema);
}

// ---- the info engine (ADR 065) ------------------------------------------------

const instant = z.string().datetime({ offset: true });
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const point = z.object({ lat: z.number(), lng: z.number() });
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

const outage = z
  .object({
    utility: z.enum(['electricity', 'gas', 'water']),
    localityId: id.nullable(),
    areaText: z.string().trim().nullable(),
    startsAt: instant,
    endsAt: instant,
    reason: z.string().trim().nullable(),
  })
  .refine((o) => new Date(o.endsAt) > new Date(o.startsAt));
export type OutageInput = z.infer<typeof outage>;

const route = z.object({
  mode: z.enum([
    'bus',
    'launch',
    'train',
    'cng',
    'cng_stand',
    'auto_rickshaw',
    'leguna',
    'microbus',
    'ferry',
  ]),
  nameBn: z.string().trim().min(1),
  nameEn: z.string().trim().nullable(),
  operatorName: z.string().trim().nullable(),
  originName: z.string().trim().min(1),
  destinationName: z.string().trim().min(1),
  originLocation: point.nullable(),
  destinationLocation: point.nullable(),
  typicalDurationMinutes: z.number().int().positive().nullable(),
  fareMin: money.nullable(),
  fareMax: money.nullable(),
  contactPhones: z.array(z.string().regex(/^\+?[0-9]{3,15}$/)),
  notes: z.string().trim().nullable(),
  stops: z.array(
    z.object({
      nameBn: z.string().trim().min(1),
      minutesFromOrigin: z.number().int().min(0).nullable(),
      fareFromOrigin: money.nullable(),
    }),
  ),
  schedules: z.array(
    z.object({
      direction: z.enum(['outbound', 'return']),
      departureTime: clock,
      days: z.array(z.number().int().min(1).max(7)).min(1),
      serviceClass: z.string().trim().nullable(),
      fare: money.nullable(),
    }),
  ),
});
export type RouteInput = z.infer<typeof route>;

const notice = z.object({
  type: z.enum([
    'government',
    'union_parishad',
    'pourashava',
    'education',
    'religious',
    'community_event',
    'weather_alert',
  ]),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  issuerName: z.string().trim().nullable(),
  validFrom: instant.nullable(),
  expiresAt: instant.nullable(),
  isOfficial: z.boolean(),
  isPinned: z.boolean(),
  attachmentIds: z.array(id),
});
export type NoticeInput = z.infer<typeof notice>;

const gov = z.object({
  slug,
  category: z.enum([
    'identity',
    'certificate',
    'land',
    'license',
    'social_safety',
    'agriculture',
    'education',
    'health',
    'utility',
    'other',
  ]),
  nameBn: z.string().trim().min(1),
  nameEn: z.string().trim().nullable(),
  summaryBn: z.string().trim().nullable(),
  officeName: z.string().trim().min(1),
  address: z.string().trim().nullable(),
  location: point.nullable(),
  hours: z.string().trim().nullable(),
  documents: z.array(z.string().trim().min(1)),
  fees: z.array(z.object({ label: z.string().trim().min(1), amount: money })),
  steps: z.array(z.string().trim().min(1)),
  links: z.array(
    z.object({ label: z.string().trim().min(1), url: z.string().url().startsWith('https://') }),
  ),
  changeNote: z.string().trim().nullable(),
});
export type GovInput = z.infer<typeof gov>;

const decision = z.object({
  decision: z.enum(['approve', 'reject', 'remove']),
  reasonCode: z.enum([
    'meets_guidelines',
    'spam',
    'false_information',
    'privacy_risk',
    'disrespectful',
    'harassment',
    'policy_violation',
    'illegal_content',
  ]),
  reasonText: z.string().trim().optional(),
});
export type InfoDecisionInput = z.infer<typeof decision>;

export async function saveOutage(
  outageId: string | null,
  input: OutageInput,
): Promise<ActionResult> {
  const parsed = outage.safeParse(input);
  if (!parsed.success || (outageId !== null && !id.safeParse(outageId).success)) return invalid;
  return outageId === null
    ? call('/info/outages', 'POST', parsed.data, infoCreatedSchema)
    : call(`/info/outages/${outageId}`, 'PUT', parsed.data, noContentSchema);
}

export async function cancelOutage(outageId: string): Promise<ActionResult> {
  if (!id.safeParse(outageId).success) return invalid;
  return call(`/info/outages/${outageId}/cancel`, 'POST', undefined, noContentSchema);
}

export async function saveRoute(routeId: string | null, input: RouteInput): Promise<ActionResult> {
  const parsed = route.safeParse(input);
  if (!parsed.success || (routeId !== null && !id.safeParse(routeId).success)) return invalid;
  return routeId === null
    ? call('/info/transport/routes', 'POST', parsed.data, infoCreatedSchema)
    : call(`/info/transport/routes/${routeId}`, 'PUT', parsed.data, infoCreatedSchema);
}

export async function verifyRoute(routeId: string): Promise<ActionResult> {
  if (!id.safeParse(routeId).success) return invalid;
  return call(`/info/transport/routes/${routeId}/verify`, 'POST', undefined, noContentSchema);
}

export async function deleteRoute(routeId: string): Promise<ActionResult> {
  if (!id.safeParse(routeId).success) return invalid;
  return call(`/info/transport/routes/${routeId}`, 'DELETE', undefined, noContentSchema);
}

export async function publishNotice(input: NoticeInput): Promise<ActionResult> {
  const parsed = notice.safeParse(input);
  if (!parsed.success) return invalid;
  return call('/info/notices', 'POST', parsed.data, infoCreatedSchema);
}

export async function saveGovService(
  serviceId: string | null,
  input: GovInput,
): Promise<ActionResult> {
  const parsed = gov.safeParse(input);
  if (!parsed.success || (serviceId !== null && !id.safeParse(serviceId).success)) return invalid;
  return serviceId === null
    ? call('/info/gov-services', 'POST', parsed.data, publishedSchema)
    : call(`/info/gov-services/${serviceId}`, 'PUT', parsed.data, publishedSchema);
}

export async function govServiceAction(
  serviceId: string,
  action: 'verify' | 'hide' | 'show',
): Promise<ActionResult> {
  if (!id.safeParse(serviceId).success || !['verify', 'hide', 'show'].includes(action))
    return invalid;
  return call(`/info/gov-services/${serviceId}/${action}`, 'POST', undefined, noContentSchema);
}

export async function decideInfoItem(
  kind: 'notice' | 'lost_found',
  itemId: string,
  input: InfoDecisionInput,
): Promise<ActionResult> {
  const parsed = decision.safeParse(input);
  if (
    !parsed.success ||
    !id.safeParse(itemId).success ||
    !['notice', 'lost_found'].includes(kind)
  ) {
    return invalid;
  }
  return call(
    `/info/moderation/${kind}/${itemId}/decision`,
    'POST',
    parsed.data,
    infoDecidedSchema,
  );
}
