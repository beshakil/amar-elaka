'use client';

import { clsx, type ClassValue } from 'clsx';
import type { ComponentProps, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

/**
 * Small styled controls for the dynamic form, using the same design tokens
 * (bg-background, border-input, ring, brand, destructive…) both Next apps
 * define in globals.css, so the renderer looks native in web and admin.
 * Plain HTML elements underneath: native semantics, keyboard support and
 * mobile keyboards come for free.
 */

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const control =
  'w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ' +
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive';

export function TextInput({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, 'h-11', className)} {...props} />;
}

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea className={cn(control, 'min-h-28 py-2 leading-relaxed', className)} {...props} />
  );
}

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(control, 'h-11 appearance-auto pr-8', className)} {...props} />;
}

/** A labelled input with a fixed prefix (৳) that screen readers skip; the label says "taka". */
export function PrefixedInput({ prefix, ...props }: ComponentProps<'input'> & { prefix: string }) {
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
      >
        {prefix}
      </span>
      <TextInput {...props} className="pl-7" />
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'onChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        checked ? 'bg-brand' : 'bg-input',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block size-5 rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

const chip =
  'inline-flex min-h-9 items-center rounded-full border px-3 text-sm transition-colors select-none ' +
  'border-input bg-background text-foreground hover:bg-muted';
const chipSelected = 'border-brand bg-brand text-brand-foreground hover:bg-brand';

/** A toggle chip for filters: a button with aria-pressed. */
export function ToggleChip({
  pressed,
  className,
  ...props
}: ComponentProps<'button'> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        chip,
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed && chipSelected,
        className,
      )}
      {...props}
    />
  );
}

/**
 * A checkbox or radio styled as a chip. The real input stays in the
 * accessibility tree (visually hidden, still focusable), so arrow keys,
 * Space and screen readers behave as for any native checkbox/radio group.
 */
export function ChoiceChip({
  label,
  checked,
  className,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & {
  type: 'checkbox' | 'radio';
  label: ReactNode;
  checked: boolean;
}) {
  return (
    <label
      className={cn(
        chip,
        'cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        checked && chipSelected,
        className,
      )}
    >
      <input className="sr-only" checked={checked} {...props} />
      {label}
    </label>
  );
}

export interface FieldShellProps {
  id: string;
  label: string;
  required: boolean;
  requiredText: string;
  hint?: string | undefined;
  error?: string | undefined;
  /** Group controls (chips, yes/no) render as fieldset + legend instead of label. */
  group?: boolean;
  children: ReactNode;
}

/** Ids the control must reference in aria-describedby, in reading order. */
export function describedBy(id: string, hint: string | undefined, error: string | undefined) {
  return (
    [hint ? `${id}-hint` : undefined, error ? `${id}-error` : undefined]
      .filter(Boolean)
      .join(' ') || undefined
  );
}

export function FieldShell({
  id,
  label,
  required,
  requiredText,
  hint,
  error,
  group,
  children,
}: FieldShellProps) {
  const title = (
    <>
      {label}
      {required && (
        <>
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
          <span className="sr-only"> ({requiredText})</span>
        </>
      )}
    </>
  );
  const footer = (
    <>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {/* Polite live region: a new or changed error is read out without stealing focus. */}
      <p id={`${id}-error`} aria-live="polite" className="text-sm text-destructive empty:hidden">
        {error}
      </p>
    </>
  );

  if (group) {
    return (
      <fieldset
        className="space-y-2"
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error ? true : undefined}
      >
        <legend className="mb-1 text-sm font-medium">{title}</legend>
        {children}
        {footer}
      </fieldset>
    );
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {title}
      </label>
      {children}
      {footer}
    </div>
  );
}
