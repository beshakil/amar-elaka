'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  FormProvider,
  useForm,
  useFormContext,
  type DefaultValues,
  type FieldValues,
  type Path,
  type SubmitHandler,
} from 'react-hook-form';
import type { z } from 'zod';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * A zod schema is the single source of truth for a form: it validates on the
 * client here and the same shape is what the API's own zod DTO validates on the
 * server, so the two cannot disagree about what is required.
 */
export function ZodForm<TSchema extends z.ZodType<FieldValues>>({
  schema,
  defaultValues,
  onSubmit,
  children,
  className,
}: {
  schema: TSchema;
  defaultValues: DefaultValues<z.infer<TSchema>>;
  onSubmit: SubmitHandler<z.infer<TSchema>>;
  children: React.ReactNode;
  className?: string;
}) {
  const form = useForm<z.infer<TSchema>>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  return (
    <FormProvider {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={cn('space-y-4', className)}
        noValidate
      >
        {children}
      </form>
    </FormProvider>
  );
}

/** Reads its error straight off the form context, so no caller wires errors up. */
export function TextField<TValues extends FieldValues>({
  name,
  label,
  type = 'text',
  autoComplete,
  placeholder,
}: {
  name: Path<TValues>;
  label: string;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  placeholder?: string;
}) {
  const { register, formState } = useFormContext<TValues>();
  const error = formState.errors[name];
  const message = typeof error?.message === 'string' ? error.message : undefined;
  const id = `field-${name}`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={message !== undefined}
        aria-describedby={message ? `${id}-error` : undefined}
        {...register(name)}
      />
      {message ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField<TValues extends FieldValues>({
  name,
  label,
  options,
  placeholder,
}: {
  name: Path<TValues>;
  label: string;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const { register, formState } = useFormContext<TValues>();
  const error = formState.errors[name];
  const message = typeof error?.message === 'string' ? error.message : undefined;
  const id = `field-${name}`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        aria-invalid={message !== undefined}
        aria-describedby={message ? `${id}-error` : undefined}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        {...register(name)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {message ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export { useFormContext };
