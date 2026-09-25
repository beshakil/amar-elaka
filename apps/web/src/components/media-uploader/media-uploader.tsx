'use client';

import { ArrowLeft, ArrowRight, ImagePlus, RotateCw, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { ACCEPTED_IMAGE_TYPES, isAcceptedImage } from '@/lib/media/compress-image';
import type { UploadItem, UploadQueue } from '@/lib/media/upload-queue';
import { cn } from '@/lib/utils';

/** The drag payload that marks a tile being moved (as opposed to files dropped in). */
const TILE_DRAG_TYPE = 'application/x-amar-elaka-photo';

/**
 * Photos for a post: drop files anywhere on the zone or pick them, watch each
 * compress and upload, reorder by dragging a tile (or with its move buttons,
 * which also serve keyboard, screen-reader and touch users — HTML drag and
 * drop doesn't work with touch), retry or remove. The first photo is the cover.
 */
export function MediaUploader({ queue }: { queue: UploadQueue }) {
  const t = useTranslations('mediaUploader');
  const format = useFormatter();
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [dragDepth, setDragDepth] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const remaining = Math.max(0, queue.maxItems - items.length);
  const done = items.filter((i) => i.status === 'done').length;

  function addFiles(files: File[]) {
    const images = files.filter(isAcceptedImage);
    const taken = queue.add(images);
    const skippedType = files.length - images.length;
    const skippedLimit = images.length - taken;
    setNotice(
      skippedType > 0
        ? t('notImages', { count: skippedType })
        : skippedLimit > 0
          ? t('overLimit', { max: format.number(queue.maxItems) })
          : null,
    );
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

  function onDrop(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragDepth(0);
    if (remaining > 0) addFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <section aria-labelledby={`${hintId}-label`} className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={`${hintId}-label`} className="text-base font-semibold">
          {t('label')}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t('count', { count: format.number(items.length), max: format.number(queue.maxItems) })}
        </span>
      </div>

      <div
        onDragEnter={(e) => carriesFiles(e) && setDragDepth((d) => d + 1)}
        onDragLeave={(e) => carriesFiles(e) && setDragDepth((d) => Math.max(0, d - 1))}
        onDragOver={(e) => carriesFiles(e) && e.preventDefault()}
        onDrop={onDrop}
        className={cn(
          'rounded-lg border-2 border-dashed p-4 transition-colors',
          dragDepth > 0 && remaining > 0 ? 'border-brand bg-brand/5' : 'border-border',
        )}
      >
        {items.length > 0 && (
          <ol className="mb-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {items.map((item, index) => (
              <PhotoTile
                key={item.id}
                item={item}
                index={index}
                count={items.length}
                queue={queue}
              />
            ))}
          </ol>
        )}

        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <ImagePlus aria-hidden className="size-8 text-muted-foreground" />
          <p id={hintId} className="text-sm text-muted-foreground">
            {remaining > 0 ? t('dropHint') : t('limitReached')}
          </p>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            hidden
            onChange={onInput}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remaining === 0}
            aria-describedby={hintId}
            onClick={() => inputRef.current?.click()}
          >
            {t('choose')}
          </Button>
        </div>
      </div>

      {notice && (
        <p role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {items.length > 0 &&
          t('progressSummary', { done: format.number(done), total: format.number(items.length) })}
      </p>
    </section>
  );
}

function PhotoTile({
  item,
  index,
  count,
  queue,
}: {
  item: UploadItem;
  index: number;
  count: number;
  queue: UploadQueue;
}) {
  const t = useTranslations('mediaUploader');
  const format = useFormatter();
  const [dropTarget, setDropTarget] = useState(false);
  const number = format.number(index + 1);
  const percent = format.number(Math.round(item.progress * 100));

  const status = {
    queued: t('status.queued'),
    compressing: t('status.compressing'),
    uploading: t('status.uploading', { percent }),
    confirming: t('status.checking'),
    done: t('status.done'),
    failed: failureMessage(t, item.errorCode),
  }[item.status];

  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TILE_DRAG_TYPE, String(index));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TILE_DRAG_TYPE)) return;
        e.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        const from = e.dataTransfer.getData(TILE_DRAG_TYPE);
        setDropTarget(false);
        if (from === '') return;
        e.preventDefault();
        queue.reorder(Number(from), index);
      }}
      aria-label={[t('photoNumber', { number }), index === 0 ? t('cover') : null, status]
        .filter(Boolean)
        .join(', ')}
      className={cn(
        'group relative aspect-square cursor-grab overflow-hidden rounded-md border bg-muted active:cursor-grabbing',
        dropTarget && 'ring-2 ring-brand',
      )}
    >
      <LocalImage blob={item.compressed ?? item.file} />

      {item.status !== 'done' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/45 p-2 text-white">
          {item.status === 'failed' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-foreground"
              onClick={() => queue.retry(item.id)}
            >
              <RotateCw aria-hidden className="size-4" />
              {t('retry')}
            </Button>
          ) : item.status === 'queued' ? null : (
            <progress
              className="h-1.5 w-4/5 overflow-hidden rounded-full accent-brand"
              max={1}
              {...(item.status === 'uploading' ? { value: item.progress } : {})}
              aria-hidden
            />
          )}
          <span className="line-clamp-2 text-center text-xs" aria-hidden>
            {status}
          </span>
        </div>
      )}

      {index === 0 && (
        <span
          aria-hidden
          className="absolute bottom-1 left-1 rounded-sm bg-brand px-1.5 text-xs text-brand-foreground"
        >
          {t('cover')}
        </span>
      )}

      <Button
        type="button"
        variant="outline"
        size="icon"
        className="absolute top-1 right-1 size-7 rounded-full bg-background/90"
        aria-label={t('remove', { number })}
        title={t('remove', { number })}
        onClick={() => queue.remove(item.id)}
      >
        <X aria-hidden className="size-4" />
      </Button>

      <div className="absolute right-1 bottom-1 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        {index > 0 && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7 rounded-full bg-background/90"
            aria-label={t('moveEarlier', { number })}
            title={t('moveEarlier', { number })}
            onClick={() => queue.reorder(index, index - 1)}
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Button>
        )}
        {index < count - 1 && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7 rounded-full bg-background/90"
            aria-label={t('moveLater', { number })}
            title={t('moveLater', { number })}
            onClick={() => queue.reorder(index, index + 1)}
          >
            <ArrowRight aria-hidden className="size-4" />
          </Button>
        )}
      </div>
    </li>
  );
}

function failureMessage(t: ReturnType<typeof useTranslations<'mediaUploader'>>, code?: string) {
  switch (code) {
    case 'compression':
    case 'UPLOAD_REJECTED':
    case 'UNSUPPORTED_CONTENT_TYPE':
      return t('errors.notAnImage');
    case 'UPLOAD_TOO_LARGE':
      return t('errors.tooLarge');
    case 'UPLOAD_RATE_LIMITED':
      return t('errors.rateLimited');
    case 'network':
    case 'timeout':
      return t('errors.network');
    default:
      return t('errors.generic');
  }
}

/**
 * A local file shown through an object URL, revoked when the file or tile
 * goes away. The URL goes straight onto the element: it's DOM sync, not state.
 */
function LocalImage({ blob }: { blob: Blob }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    if (ref.current) ref.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return (
    // A local object URL: next/image can't optimise it and needn't.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      alt=""
      className="size-full object-cover"
      draggable={false}
      // A file the browser can't decode: the tile's status says why.
      onError={(event) => (event.currentTarget.style.visibility = 'hidden')}
    />
  );
}
