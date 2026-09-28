'use client';

import { useEffect } from 'react';

/** Counts the view once the page is in the browser (never during server rendering or prefetch). */
export function ViewBeacon({ postId }: { postId: string }) {
  useEffect(() => {
    const url = `/api/posts/${postId}/view`;
    if (!navigator.sendBeacon?.(url)) void fetch(url, { method: 'POST', keepalive: true });
  }, [postId]);
  return null;
}
