import { SchemaPreview, type PreviewCategory } from '@amar-elaka/dynamic-form/react';
import rentACar from '@amar-elaka/dynamic-form/fixtures/rent-a-car.json';
import toLet from '@amar-elaka/dynamic-form/fixtures/to-let.json';
import { notFound } from 'next/navigation';

/**
 * Dev-only preview of the dynamic category form and filters (the same
 * renderer the public site uses), with the to-let and rent-a-car schemas
 * from the seed taxonomy. Not served in production.
 */
export default function FormPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <SchemaPreview categories={[toLet, rentACar] as PreviewCategory[]} />;
}
