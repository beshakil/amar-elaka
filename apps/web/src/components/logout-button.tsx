'use client';

import { useRouter } from 'next/navigation';

/** Ends the session through this app's route handler, then reloads as a guest. */
export function LogoutButton({ label }: { label: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="rounded-md px-2 py-1 hover:bg-muted"
      onClick={async () => {
        await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        router.push('/');
        router.refresh();
      }}
    >
      {label}
    </button>
  );
}
