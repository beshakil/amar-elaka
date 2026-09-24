import { notFound } from 'next/navigation';
import { currentViewer, hasGrant, type Viewer } from './me';

/**
 * Page gates. Call them from a segment's layout.tsx, which renders above that
 * segment's loading.tsx: a denial there happens before the first byte is
 * streamed, so the response status is a real 404. Called from inside the
 * loading boundary, the shell would already have been sent with a 200.
 *
 * Pages call the same gate before fetching, so a denied viewer never costs an
 * API round trip. Hiding a nav item is a convenience; these are the checks.
 */
export async function requireGrant(required: { module: string; action: string }): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!hasGrant(viewer.permissions, required)) notFound();
  return viewer;
}

export async function requirePlatformAdmin(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer.permissions.isPlatformAdmin) notFound();
  return viewer;
}
