'use client';

import './globals.css';

/**
 * The last resort: a failure in the root layout itself, which means next-intl's
 * provider never mounted. Strings are inline here because there is no message
 * catalog available at this point — not a rule-6 exception anywhere else.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="bn">
      <body className="flex min-h-dvh items-center justify-center p-6 font-sans antialiased">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold">কিছু একটা ভুল হয়েছে</h1>
          <p className="mt-3 text-muted-foreground">
            সাময়িক সমস্যার কারণে পাতাটি দেখানো যায়নি। আবার চেষ্টা করুন।
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-6 inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-brand-foreground"
          >
            আবার চেষ্টা করুন
          </button>
        </div>
      </body>
    </html>
  );
}
