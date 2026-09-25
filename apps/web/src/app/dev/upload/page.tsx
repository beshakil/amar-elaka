import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UploadPreview } from './upload-preview';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Dev-only preview of the photo uploader: real compression in the browser,
 * simulated transport (nothing is sent). Not served in production.
 */
export default function UploadPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main id="main" className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <UploadPreview />
    </main>
  );
}
