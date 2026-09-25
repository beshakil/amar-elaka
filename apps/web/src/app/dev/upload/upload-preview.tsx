'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { MediaUploader } from '@/components/media-uploader/media-uploader';
import { compressImage } from '@/lib/media/compress-image';
import { createSimulatedTransport } from '@/lib/media/simulated-transport';
import { UploadQueue } from '@/lib/media/upload-queue';

export function UploadPreview() {
  const t = useTranslations('mediaUploader');
  const [queue] = useState(
    () => new UploadQueue({ transport: createSimulatedTransport(), compress: compressImage }),
  );
  useEffect(() => () => queue.dispose(), [queue]);
  useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);

  return (
    <>
      <MediaUploader queue={queue} />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('previewOutput')}</h2>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs" data-testid="media-ids">
          {JSON.stringify({ mediaIds: queue.mediaIds }, null, 2)}
        </pre>
      </section>
    </>
  );
}
