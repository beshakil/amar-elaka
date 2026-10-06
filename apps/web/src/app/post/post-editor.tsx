'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formStateToValues,
  localizeDigits,
  valuesToFormState,
  type CategoryFieldSchema,
  type FieldValues,
  type FormState,
} from '@amar-elaka/dynamic-form';
import { DynamicForm } from '@amar-elaka/dynamic-form/react';
import { MediaUploader } from '@/components/media-uploader/media-uploader';
import { CategoryIcon } from '@/components/posts/category-icon';
import type { GeoAnswer, PickerGeo } from '@/components/map/location-picker';
import { pickedLabel } from '@/components/map/location-picker';
import { LocationPickerLazy } from '@/components/map/location-picker-lazy';
import { PostCard } from '@/components/posts/post-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CatalogCategory, MapConfig, Ownership, Post } from '@/lib/api/schemas';
import { compressImage } from '@/lib/media/compress-image';
import { UploadQueue } from '@/lib/media/upload-queue';
import { createWebUploadTransport } from '@/lib/media/web-upload-transport';
import {
  areasAt,
  createPost,
  ownershipAt,
  reverseGeocode,
  searchAddress,
  updatePost,
  type ActionResult,
} from '@/lib/posts/actions';
import { cardFacts } from '@/lib/posts/display';
import { emptyDraft, localPhone, type PostDraft } from '@/lib/posts/draft';
import { clearDraft, draftKey, loadDraft, saveDraft } from '@/lib/posts/draft-storage';
import { postErrorMessage, type PostError } from '@/lib/posts/errors';
import { postRequestBody, sectionIssues, type SectionIssue } from '@/lib/posts/request-body';
import { cn } from '@/lib/utils';

const FORM_ID = 'post-fields';
// Autosave debounce: fewer writes than one per keystroke, and a reload loses
// at most a moment of typing.
const SAVE_DEBOUNCE_MS = 400;

export interface EditorTenant {
  id: string;
  nameBn: string;
  mapCenter: { lat: number; lng: number };
  typicalReviewHours: number;
}

type Mode = { kind: 'create' } | { kind: 'edit'; post: Post };

type Result = { post: Post; wasEdit: boolean };

/** A server action's answer as the picker reads it. */
const geoAnswer = <T,>(result: ActionResult<T>): GeoAnswer<T> =>
  result.ok ? result : { ok: false, offline: result.error.code === 'NETWORK' };

/** The post's pin: `purpose=post_location` (settings decide which Barikoi fields that costs). */
const pickerGeo: PickerGeo = {
  areasAt: async (lat, lng) => geoAnswer(await areasAt(lat, lng)),
  reverse: async (lat, lng) => geoAnswer(await reverseGeocode(lat, lng, 'post_location')),
  autocomplete: async (query, near) => geoAnswer(await searchAddress(query, near)),
};

const schemaOf = (category: CatalogCategory | undefined): CategoryFieldSchema | null =>
  (category?.fieldSchema as CategoryFieldSchema | null | undefined) ?? null;

/**
 * Create or edit a post on one page (desktop), one section per mobile step:
 * category → details → photos → location → contact, with a live preview of
 * the card beside them. Everything typed is saved to the browser as it
 * changes; "post" sends it with the draft's Idempotency-Key and says plainly
 * what came of it.
 */
export function PostEditor({
  mode,
  categories,
  me,
  tenant,
  mapConfig,
}: {
  mode: Mode;
  categories: CatalogCategory[];
  me: { displayName: string; phone: string };
  tenant: EditorTenant;
  /** GET /map/config; null when the API couldn't say (the map shows a notice). */
  mapConfig: MapConfig | null;
}) {
  const t = useTranslations('postEditor');
  const tErr = useTranslations('postErrors');
  const tMy = useTranslations('myPosts');
  const format = useFormatter();
  const storageKey = draftKey(tenant.id, mode.kind === 'edit' ? mode.post.id : null);

  const initial = useMemo((): PostDraft => {
    if (mode.kind === 'create') {
      return emptyDraft({ name: me.displayName, phone: me.phone }, () => crypto.randomUUID());
    }
    const { post } = mode;
    const schema = schemaOf(categories.find((c) => c.id === post.categoryId));
    return {
      idempotencyKey: `edit-${post.id}`,
      categoryId: post.categoryId,
      title: post.title,
      description: post.description ?? '',
      formState: schema ? valuesToFormState(schema, post.fields as FieldValues, 'bn') : {},
      existingMedia: post.media.map((m) => ({ id: m.id, thumbUrl: m.thumbUrl })),
      location: post.location,
      addressLabel: null,
      contactName: post.contact.name ?? me.displayName,
      contactPhone: localPhone(post.contact.phone ?? me.phone),
      showPhone: post.showPhone,
      allowChat: post.allowChat,
      showWhatsapp: post.showWhatsapp,
    };
  }, [mode, categories, me]);

  const [draft, setDraft] = useState<PostDraft>(initial);
  const [restored, setRestored] = useState(false);
  // The form remounts (with the right defaults) when this changes.
  const [formKey, setFormKey] = useState(0);
  const [categoryQuery, setCategoryQuery] = useState('');
  const [showIssues, setShowIssues] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [waitingForPhotos, setWaitingForPhotos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [ownership, setOwnership] = useState<Ownership | null>(null);
  /** The address line came from the geocoding provider (Barikoi), not our own area names. */
  const ownershipCheck = useRef(0);

  const [queue] = useState(
    () => new UploadQueue({ transport: createWebUploadTransport(), compress: compressImage }),
  );
  useEffect(() => () => queue.dispose(), [queue]);

  // Restore a saved draft once, in the browser. An effect on purpose: the
  // server can't read localStorage, so reading it during render would make
  // the first client render differ from the server's (a hydration mismatch).
  useEffect(() => {
    const saved = loadDraft(storageKey);
    if (saved) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setDraft(saved);
      setRestored(true);
      setFormKey((k) => k + 1);
    }
  }, [storageKey]);

  // Autosave.
  useEffect(() => {
    if (result) return;
    const timer = setTimeout(() => saveDraft(storageKey, draft), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, storageKey, result]);

  const category = categories.find((c) => c.id === draft.categoryId);
  const schema = schemaOf(category);
  const issues = new Set<SectionIssue>(showIssues ? sectionIssues(draft) : []);
  const update = (change: Partial<PostDraft>) => setDraft((d) => ({ ...d, ...change }));

  function describe(failure: PostError): string {
    const message = postErrorMessage(failure, (iso) =>
      format.dateTime(new Date(iso), { day: 'numeric', month: 'long' }),
    );
    return tErr(message.key, message.values);
  }

  function pickCategory(next: CatalogCategory) {
    if (next.id === draft.categoryId) return;
    if (Object.keys(draft.formState).length > 0 && !window.confirm(t('categoryChangeConfirm')))
      return;
    update({ categoryId: next.id, formState: {} });
    setFormKey((k) => k + 1);
  }

  /** The post's point is checked against the area's boundary: outside is a warning, never a block. */
  async function checkOwnership(point: { lat: number; lng: number }) {
    const id = ++ownershipCheck.current;
    const owner = await ownershipAt(point.lat, point.lng);
    if (id === ownershipCheck.current) setOwnership(owner.ok ? owner.data : null);
  }

  async function submit(fields: FieldValues) {
    setShowIssues(true);
    setError(null);
    if (!schema || sectionIssues(draft).length > 0) {
      setError(t('fixBeforeSubmit'));
      return;
    }
    setSubmitting(true);
    // Photos still uploading: wait for them (as the app does), then check.
    if (queue.isBusy) {
      setWaitingForPhotos(true);
      await queue.settled();
      setWaitingForPhotos(false);
    }
    const failed = queue.getSnapshot().filter((u) => u.status === 'failed').length;
    if (failed > 0) {
      setSubmitting(false);
      setError(t('photosFailed', { count: localizeDigits(String(failed), 'bn') }));
      return;
    }
    const body = postRequestBody(draft, schema, queue.mediaIds, {
      isEdit: mode.kind === 'edit',
      fields,
    });
    let answer: ActionResult<Post>;
    try {
      answer =
        mode.kind === 'edit'
          ? await updatePost(mode.post.id, body)
          : await createPost(body, draft.idempotencyKey);
    } catch {
      answer = { ok: false, error: { code: 'NETWORK' } };
    }
    setSubmitting(false);
    if (answer.ok) {
      clearDraft(storageKey);
      setResult({ post: answer.data, wasEdit: mode.kind === 'edit' });
      window.scrollTo({ top: 0 });
      return;
    }
    setError(describe(answer.error));
  }

  if (result) {
    const live = result.post.status === 'live';
    return (
      <section className="mx-auto max-w-xl space-y-4 text-center" aria-live="polite">
        <h1 className="text-2xl font-semibold">
          {live
            ? result.wasEdit
              ? t('resultSavedTitle')
              : t('resultLiveTitle')
            : t('resultPendingTitle')}
        </h1>
        <p>
          {live
            ? t('resultLiveBody')
            : t('resultPendingBody', {
                hours: localizeDigits(String(tenant.typicalReviewHours), 'bn'),
              })}
        </p>
        <div className="flex justify-center gap-3">
          {/* Full loads: seller pages render afresh from the server with the session. */}
          <Button asChild>
            <a href="/me/posts">{t('goToMyPosts')}</a>
          </Button>
          <Button asChild variant="outline">
            <a href="/post/new">{t('postAnother')}</a>
          </Button>
        </div>
      </section>
    );
  }

  const values = schema ? formStateToValues(schema.jsonSchema, draft.formState) : {};
  const facts = cardFacts(schema, values, 'bn', { yes: t('yes'), no: t('no') });
  const coverUrl = draft.existingMedia[0]?.thumbUrl ?? null;
  const visibleCategories = categories.filter((c) => {
    const q = categoryQuery.trim().toLowerCase();
    return (
      !q ||
      c.name.bn.toLowerCase().includes(q) ||
      c.name.en.toLowerCase().includes(q) ||
      c.slug.includes(q)
    );
  });
  const fieldError = (show: boolean, message: string) =>
    show ? (
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
    ) : null;
  const submitLabel =
    mode.kind === 'create'
      ? t('submit')
      : mode.post.status === 'rejected' || mode.post.status === 'removed'
        ? t('resubmit')
        : t('saveChanges');

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-10">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">
            {mode.kind === 'edit' ? t('titleEdit') : t('titleNew')}
          </h1>
          {restored && (
            <p className="text-sm text-muted-foreground">
              {t('draftRestored')}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  clearDraft(storageKey);
                  setDraft(initial);
                  setRestored(false);
                  setFormKey((k) => k + 1);
                }}
              >
                {t('discardDraft')}
              </button>
            </p>
          )}
        </header>

        <section id="section-category" className="space-y-3" aria-labelledby="h-category">
          <h2 id="h-category" className="text-lg font-semibold">
            {t('sectionCategory')}
          </h2>
          <Input
            placeholder={t('categorySearch')}
            aria-label={t('categorySearch')}
            value={categoryQuery}
            onChange={(event) => setCategoryQuery(event.target.value)}
          />
          {visibleCategories.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('categoryEmpty')}</p>
          ) : (
            <div
              className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6"
              role="radiogroup"
              aria-labelledby="h-category"
            >
              {visibleCategories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={c.id === draft.categoryId}
                  onClick={() => pickCategory(c)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-lg border p-3 text-center text-sm hover:bg-muted',
                    c.id === draft.categoryId ? 'border-brand bg-brand/10' : 'border-border',
                  )}
                >
                  <CategoryIcon iconKey={c.iconKey} className="size-6 text-brand" />
                  <span className="line-clamp-2">{c.name.bn}</span>
                  {c.requiresApproval && (
                    <span className="text-xs text-muted-foreground">{t('categoryReviewed')}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {fieldError(issues.has('category'), t('categoryRequired'))}
        </section>

        <section id="section-details" className="space-y-4" aria-labelledby="h-details">
          <h2 id="h-details" className="text-lg font-semibold">
            {t('sectionDetails')}
          </h2>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('titleLabel')} *</span>
            <Input
              name="title"
              placeholder={t('titleHint')}
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              aria-invalid={issues.has('title')}
            />
          </label>
          {fieldError(issues.has('title'), t('titleRequired'))}
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('descriptionLabel')}</span>
            <textarea
              name="description"
              rows={5}
              placeholder={t('descriptionHint')}
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          {schema ? (
            <DynamicForm
              key={`${draft.categoryId}-${formKey}`}
              id={FORM_ID}
              schema={schema}
              hideSubmit
              locale="bn"
              defaultState={draft.formState}
              onStateChange={(state: FormState) => update({ formState: state })}
              onSubmit={submit}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t('chooseCategoryFirst')}</p>
          )}
        </section>

        <section id="section-photos" className="space-y-3" aria-labelledby="h-photos">
          <h2 id="h-photos" className="text-lg font-semibold">
            {t('sectionPhotos')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('photosHint')}</p>
          {draft.existingMedia.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('photosExisting')}</p>
              <ul className="flex flex-wrap gap-2">
                {draft.existingMedia.map((media) => (
                  <li
                    key={media.id}
                    className="relative size-24 overflow-hidden rounded-md bg-muted"
                  >
                    {media.thumbUrl && (
                      // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
                      <img src={media.thumbUrl} alt="" className="size-full object-cover" />
                    )}
                    <button
                      type="button"
                      aria-label={t('removePhoto')}
                      className="absolute top-1 right-1 rounded bg-background/90 px-1 text-xs"
                      onClick={() =>
                        update({
                          existingMedia: draft.existingMedia.filter((m) => m.id !== media.id),
                        })
                      }
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <MediaUploader queue={queue} />
        </section>

        <section id="section-location" className="space-y-3" aria-labelledby="h-location">
          <h2 id="h-location" className="text-lg font-semibold">
            {t('sectionLocation')}
          </h2>
          <LocationPickerLazy
            config={mapConfig}
            initial={draft.location}
            center={tenant.mapCenter}
            geo={pickerGeo}
            onChange={(picked) =>
              update({ location: picked.point, addressLabel: pickedLabel(picked) })
            }
            onPointSettled={(point) => void checkOwnership(point)}
          />
          {ownership?.outsideBoundary && (
            <p
              role="status"
              className="rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm"
            >
              {t('outsideWarning', { tenant: tenant.nameBn })}{' '}
              {ownership.needsReview ? t('needsReview') : ''}
            </p>
          )}
          {fieldError(issues.has('location'), t('locationRequired'))}
        </section>

        <section id="section-contact" className="space-y-3" aria-labelledby="h-contact">
          <h2 id="h-contact" className="text-lg font-semibold">
            {t('sectionContact')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('contactFromProfile')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('contactName')} *</span>
              <Input
                value={draft.contactName}
                onChange={(event) => update({ contactName: event.target.value })}
              />
              {fieldError(issues.has('contactName'), t('contactNameRequired'))}
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('contactPhone')}</span>
              <Input
                type="tel"
                inputMode="tel"
                value={draft.contactPhone}
                onChange={(event) => update({ contactPhone: event.target.value })}
              />
              {fieldError(issues.has('contactPhone'), t('contactPhoneInvalid'))}
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.showPhone}
              onChange={(event) =>
                update({
                  showPhone: event.target.checked,
                  showWhatsapp: event.target.checked && draft.showWhatsapp,
                })
              }
            />
            {t('showPhone')} <span className="text-muted-foreground">— {t('showPhoneHint')}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.showWhatsapp}
              disabled={!draft.showPhone}
              onChange={(event) => update({ showWhatsapp: event.target.checked })}
            />
            {t('whatsapp')}
            {!draft.showPhone && (
              <span className="text-muted-foreground">— {t('whatsappNeedsPhone')}</span>
            )}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allowChat}
              onChange={(event) => update({ allowChat: event.target.checked })}
            />
            {t('allowChat')}
          </label>
          {fieldError(issues.has('unreachable'), t('unreachable'))}
        </section>

        <div className="space-y-3 border-t border-border pt-6">
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <Button
            type={schema ? 'submit' : 'button'}
            form={schema ? FORM_ID : undefined}
            disabled={submitting}
            onClick={() => {
              setShowIssues(true);
              if (!schema) setError(t('fixBeforeSubmit'));
            }}
          >
            {waitingForPhotos ? t('waitForPhotos') : submitting ? t('submitting') : submitLabel}
          </Button>
        </div>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start" aria-labelledby="h-preview">
        <h2 id="h-preview" className="text-lg font-semibold">
          {t('sectionPreview')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('previewHint')}</p>
        <PostCard
          data={{
            title: draft.title,
            price: facts.price,
            attributes: facts.attributes,
            place: draft.addressLabel,
            posted: t('today'),
            photoUrl: coverUrl,
          }}
          labels={{
            priceOnRequest: t('priceOnRequest'),
            noPhotos: t('noPhotos'),
            sold: tMy('status.sold'),
          }}
        />
      </aside>
    </div>
  );
}
