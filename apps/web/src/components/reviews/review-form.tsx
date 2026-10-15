'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ImagePlus, Star, X } from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { Button } from '@/components/ui/button';
import type { MyReview } from '@/lib/api/schemas';
import { compressImage, isAcceptedImage } from '@/lib/media/compress-image';
import { sha256Hex } from '@/lib/media/upload-queue';
import { writeReview } from '@/lib/reviews/actions';
import { cn } from '@/lib/utils';

interface Photo {
  /** Uploaded already (an existing photo of this review, or done just now). */
  id?: string;
  previewUrl: string;
  file?: File;
}

// Presentation: the picker stops here; the API's review_photos_max decides.
const PICKER_CAP = 3;

/**
 * Writing a review on the web (ADR 061), or editing one's own: stars, words,
 * a few photos (compressed here, uploaded through this site into the store's
 * area). A review the integrity checks hold is said to wait for a moderator.
 */
export function ReviewForm({
  storeId,
  backTo,
  mine,
}: {
  storeId: string;
  backTo: string;
  mine: MyReview | null;
}) {
  const t = useTranslations('reviews');
  const router = useRouter();
  const [rating, setRating] = useState(mine?.rating ?? 0);
  const [text, setText] = useState(mine?.text ?? '');
  const [photos, setPhotos] = useState<Photo[]>(
    (mine?.photos ?? []).flatMap((p) => (p.thumbUrl ? [{ id: p.id, previewUrl: p.thumbUrl }] : [])),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function upload(file: File): Promise<string | null> {
    const compressed = await compressImage(file);
    const response = await fetch(`/api/media/upload?reviewStore=${storeId}`, {
      method: 'POST',
      headers: { 'content-type': compressed.type, 'x-content-sha256': await sha256Hex(compressed) },
      body: compressed,
    });
    const body = (await response.json().catch(() => ({}))) as { mediaId?: string };
    return response.ok && body.mediaId ? body.mediaId : null;
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const photoIds: string[] = [];
      for (const p of photos) {
        const id = p.id ?? (p.file ? await upload(p.file).catch(() => null) : null);
        if (!id) {
          setMessage(t('errors.photo'));
          return;
        }
        photoIds.push(id);
      }
      const result = await writeReview(
        storeId,
        { rating, text: text.trim() || null, photoIds },
        mine !== null,
      );
      if (result.ok) {
        setMessage(result.data.needsReview ? t('submittedPending') : t('submitted'));
        router.push(backTo as Route);
        router.refresh();
        return;
      }
      const max = (result.details as { max?: number } | null | undefined)?.max;
      const known = [
        'REVIEW_TEXT_TOO_LONG',
        'REVIEW_PHOTOS_INVALID',
        'REVIEW_EDIT_WINDOW_OVER',
        'REVIEW_DECIDED_BY_MODERATOR',
        'REVIEW_NOT_ELIGIBLE',
      ];
      setMessage(
        known.includes(result.code)
          ? t(`errors.${result.code}`, { max: localizeDigits(String(max ?? ''), 'bn') })
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset>
        <legend className="mb-2 font-medium">{t('ratingLabel')}</legend>
        <div className="flex gap-1" role="radiogroup">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className="cursor-pointer"
              title={t('stars', { count: localizeDigits(String(n), 'bn') })}
            >
              <input
                type="radio"
                name="rating"
                value={n}
                checked={rating === n}
                onChange={() => setRating(n)}
                className="sr-only"
                data-testid={`star-${n}`}
              />
              <Star
                className={cn(
                  'size-9 text-amber-600 dark:text-amber-400',
                  rating >= n && 'fill-current',
                )}
                aria-hidden
              />
              <span className="sr-only">
                {t('stars', { count: localizeDigits(String(n), 'bn') })}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
        placeholder={t('textHint')}
        aria-label={t('textHint')}
        className="w-full rounded-md border border-border bg-background p-3"
        data-testid="review-text"
      />
      <div className="flex flex-wrap items-center gap-3">
        {photos.map((p, i) => (
          <div key={p.previewUrl} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local preview or a storage URL */}
            <img src={p.previewUrl} alt="" className="size-20 rounded-md object-cover" />
            <button
              type="button"
              aria-label={t('removePhoto')}
              className="absolute -top-2 -right-2 rounded-full bg-card p-1 shadow"
              onClick={() => setPhotos((all) => all.filter((_, j) => j !== i))}
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        ))}
        {photos.length < PICKER_CAP && (
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
            <ImagePlus className="size-4" aria-hidden />
            {t('addPhoto')}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (!isAcceptedImage(file)) {
                  setMessage(t('errors.photo'));
                  return;
                }
                setPhotos((all) => [...all, { previewUrl: URL.createObjectURL(file), file }]);
              }}
            />
          </label>
        )}
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <Button type="submit" disabled={rating === 0 || busy} data-testid="review-submit">
        {busy ? t('sending') : mine ? t('save') : t('submit')}
      </Button>
    </form>
  );
}
