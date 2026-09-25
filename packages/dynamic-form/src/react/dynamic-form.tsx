'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  Controller,
  useForm,
  useWatch,
  type Control,
  type FieldErrors,
  type Resolver,
} from 'react-hook-form';
import {
  buildFormSchema,
  formStateIssues,
  formStateToValues,
  valuesToFormState,
  type FormState,
} from '../form-values';
import { describeIssue } from '../messages';
import { formatMoney, localizeDigits, parseMoneyInput, parseNumberInput } from '../numerals';
import {
  formFieldKeys,
  isRequired,
  labelOf,
  optionCodes,
  optionLabel,
  type CategoryFieldSchema,
  type FieldProperty,
  type FieldValues,
  type Locale,
} from '../schema';
import {
  FIELD_ISSUES,
  validationContextAt,
  visibleFields,
  type ValidationContext,
} from '../validation';
import {
  ChoiceChip,
  FieldShell,
  NativeSelect,
  PrefixedInput,
  Switch,
  TextArea,
  TextInput,
  cn,
  describedBy,
} from './primitives';

/**
 * Renders a category field schema as a form (react-hook-form + a zod schema
 * built at runtime from the definition, validation.ts). Values come out
 * API-shaped (Latin digits, "15000.00" money, E.164 phones) and already
 * validated with the server's rules; hidden conditional fields are never
 * submitted.
 */
export interface DynamicFormProps {
  schema: CategoryFieldSchema;
  onSubmit: (values: FieldValues) => void | Promise<void>;
  /** Stored values to edit (a post's `fields`). */
  defaultValues?: FieldValues;
  /** Defaults to the next-intl locale. */
  locale?: Locale;
  /** "Today" and the current year for date/year rules; defaults to now in Asia/Dhaka. */
  context?: ValidationContext;
  submitLabel?: string;
  className?: string;
  /** Rendered next to the submit button (cancel, save draft…). */
  actions?: ReactNode;
}

type Translate = ReturnType<typeof useTranslations<'dynamicForm'>>;
/** Message ids from describeIssue() are computed, so they can't be checked against the catalog's key union. */
type TranslateDynamic = (id: string, values?: Record<string, string>) => string;

/** The issue code react-hook-form holds for a field; a multiselect's is on one of its items. */
function errorCodeOf(errors: FieldErrors<FormState>, key: string): string | undefined {
  const error = errors[key] as { message?: unknown } | { message?: unknown }[] | undefined;
  if (Array.isArray(error)) {
    const item = error.find((e) => typeof e?.message === 'string');
    return item?.message as string | undefined;
  }
  return typeof error?.message === 'string' ? error.message : undefined;
}

export function DynamicForm({
  schema,
  onSubmit,
  defaultValues,
  locale: localeProp,
  context: contextProp,
  submitLabel,
  className,
  actions,
}: DynamicFormProps) {
  const intlLocale = useLocale();
  const locale: Locale = localeProp ?? (intlLocale === 'en' ? 'en' : 'bn');
  const t = useTranslations('dynamicForm');
  const [context] = useState(() => contextProp ?? validationContextAt(new Date()));
  const baseId = useId();
  const [summary, setSummary] = useState<number | null>(null);

  const resolver = useMemo((): Resolver<FormState, unknown, FieldValues> => {
    const zod = zodResolver(buildFormSchema(schema.jsonSchema, context));
    // zod stops before "required while shown" once any field has a type
    // problem; add those so one submit shows every missing field.
    return async (state, ctx, options) => {
      const result = await zod(state, ctx, options);
      if (Object.keys(result.errors).length === 0) return result;
      const errors: FieldErrors<FormState> = { ...result.errors };
      for (const issue of formStateIssues(schema.jsonSchema, state, context)) {
        const key = issue.field.split('.')[0]!;
        if (errors[key] === undefined && issue.code === FIELD_ISSUES.required) {
          errors[key] = { type: 'required', message: issue.code };
        }
      }
      return { values: {}, errors };
    };
  }, [schema, context]);
  const form = useForm<FormState, unknown, FieldValues>({
    resolver,
    defaultValues: defaultValues ? valuesToFormState(schema, defaultValues, locale) : {},
    mode: 'onTouched',
    shouldFocusError: true,
  });
  const state = useWatch({ control: form.control });
  const visible = visibleFields(schema.jsonSchema, formStateToValues(schema.jsonSchema, state));
  const keys = formFieldKeys(schema).filter((key) => visible.has(key));
  const errors = form.formState.errors;

  const submit = form.handleSubmit(
    async (values) => {
      setSummary(null);
      await onSubmit(values);
    },
    (invalid) => setSummary(Object.keys(invalid).length),
  );

  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className={cn('space-y-5', className)}
    >
      {summary !== null && summary > 0 && (
        // Announced once per failed submit; focus moves to the first invalid field.
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {t('ui.errorSummary', { count: summary })}
        </div>
      )}

      {keys.map((key) => {
        const code = errorCodeOf(errors, key);
        const ref = code ? describeIssue(schema, key, code, locale, context) : undefined;
        return (
          <FieldControl
            key={key}
            id={`${baseId}-${key}`}
            fieldKey={key}
            schema={schema}
            property={schema.jsonSchema.properties[key]!}
            locale={locale}
            context={context}
            control={form.control}
            error={ref ? (t as unknown as TranslateDynamic)(ref.id, ref.values) : undefined}
            t={t}
          />
        );
      })}

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="inline-flex h-11 items-center rounded-md bg-brand px-5 text-sm font-medium text-brand-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {submitLabel ?? t('ui.submit')}
        </button>
        {actions}
      </div>
    </form>
  );
}

interface FieldControlProps {
  id: string;
  fieldKey: string;
  schema: CategoryFieldSchema;
  property: FieldProperty;
  locale: Locale;
  context: ValidationContext;
  control: Control<FormState, unknown, FieldValues>;
  error: string | undefined;
  t: Translate;
}

/** Selects with this many options or fewer render as one-tap radio chips. */
const CHIP_SELECT_MAX_OPTIONS = 4;

function FieldControl({
  id,
  fieldKey,
  schema,
  property,
  locale,
  context,
  control,
  error,
  t,
}: FieldControlProps) {
  const label = labelOf(schema, fieldKey, locale);
  const required = isRequired(schema, fieldKey);
  const type = property['x-field-type'];

  const hint =
    type === 'money' ? t('ui.moneyHint') : type === 'phone' ? t('ui.phoneHint') : undefined;
  const shell = { id, label, required, requiredText: t('ui.required'), error };
  const aria = (h: string | undefined) => ({
    'aria-invalid': error ? true : undefined,
    'aria-required': required || undefined,
    'aria-describedby': describedBy(id, h, error),
  });

  return (
    <Controller
      name={fieldKey}
      control={control}
      render={({ field }) => {
        const text = typeof field.value === 'string' ? field.value : '';
        const common = { id, name: field.name, ref: field.ref, onBlur: field.onBlur };

        switch (type) {
          case 'text':
            return (
              <FieldShell {...shell}>
                <TextInput
                  {...common}
                  {...aria(undefined)}
                  type={property.format === 'uri' ? 'url' : 'text'}
                  inputMode={property.format === 'uri' ? 'url' : undefined}
                  maxLength={property.maxLength}
                  value={text}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              </FieldShell>
            );

          case 'textarea': {
            const counter = t('ui.characterCount', {
              count: localizeDigits(String(text.length), locale),
              max: localizeDigits(String(property.maxLength), locale),
            });
            return (
              <FieldShell {...shell} hint={counter}>
                <TextArea
                  {...common}
                  {...aria(counter)}
                  maxLength={property.maxLength}
                  value={text}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              </FieldShell>
            );
          }

          case 'number':
            return (
              <FieldShell {...shell}>
                <TextInput
                  {...common}
                  {...aria(undefined)}
                  // type="number" would reject Bengali digits; the keyboard hint is enough.
                  type="text"
                  inputMode={property.type === 'integer' ? 'numeric' : 'decimal'}
                  autoComplete="off"
                  value={text}
                  onChange={(e) => field.onChange(e.target.value)}
                  onBlur={() => {
                    const parsed = parseNumberInput(text);
                    if (!Number.isNaN(parsed))
                      field.onChange(localizeDigits(String(parsed), locale));
                    field.onBlur();
                  }}
                />
              </FieldShell>
            );

          case 'money':
            return (
              <FieldShell {...shell} hint={hint}>
                <PrefixedInput
                  {...common}
                  {...aria(hint)}
                  prefix="৳"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={text}
                  onChange={(e) => field.onChange(e.target.value)}
                  onBlur={() => {
                    const parsed = parseMoneyInput(text);
                    if (parsed !== undefined) field.onChange(formatMoney(parsed, locale));
                    field.onBlur();
                  }}
                />
              </FieldShell>
            );

          case 'phone':
            return (
              <FieldShell {...shell} hint={hint}>
                <TextInput
                  {...common}
                  {...aria(hint)}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  value={text}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              </FieldShell>
            );

          case 'date':
            return (
              <FieldShell {...shell}>
                <TextInput
                  {...common}
                  {...aria(undefined)}
                  type="date"
                  lang={locale}
                  min={property['x-not-before-today'] ? context.today : undefined}
                  value={text}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              </FieldShell>
            );

          case 'bool': {
            const value = typeof field.value === 'boolean' ? field.value : undefined;
            if (required) {
              // Required: an explicit yes/no, so "not answered" never looks like "no".
              return (
                <FieldShell {...shell} group>
                  <div className="flex gap-2">
                    {([true, false] as const).map((option) => (
                      <ChoiceChip
                        key={String(option)}
                        type="radio"
                        name={field.name}
                        label={option ? t('ui.yes') : t('ui.no')}
                        checked={value === option}
                        onChange={() => field.onChange(option)}
                        onBlur={field.onBlur}
                        ref={option ? field.ref : undefined}
                      />
                    ))}
                  </div>
                </FieldShell>
              );
            }
            return (
              <div className="flex items-center justify-between gap-4">
                <label htmlFor={id} className="text-sm font-medium">
                  {label}
                </label>
                <Switch
                  id={id}
                  ref={field.ref}
                  checked={value === true}
                  onCheckedChange={(checked) => field.onChange(checked)}
                  onBlur={field.onBlur}
                  aria-describedby={describedBy(id, undefined, error)}
                />
                <p id={`${id}-error`} aria-live="polite" className="sr-only">
                  {error}
                </p>
              </div>
            );
          }

          case 'select': {
            const codes = optionCodes(property);
            if (codes.length <= CHIP_SELECT_MAX_OPTIONS) {
              return (
                <FieldShell {...shell} group>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
                    {codes.map((code, index) => (
                      <ChoiceChip
                        key={code}
                        type="radio"
                        name={field.name}
                        value={code}
                        label={optionLabel(schema, fieldKey, code, locale)}
                        checked={field.value === code}
                        onChange={() => field.onChange(code)}
                        onBlur={field.onBlur}
                        ref={index === 0 ? field.ref : undefined}
                      />
                    ))}
                  </div>
                </FieldShell>
              );
            }
            return (
              <FieldShell {...shell}>
                <NativeSelect
                  {...common}
                  {...aria(undefined)}
                  value={text}
                  onChange={(e) => field.onChange(e.target.value)}
                >
                  <option value="">{t('ui.choose')}</option>
                  {codes.map((code) => (
                    <option key={code} value={code}>
                      {optionLabel(schema, fieldKey, code, locale)}
                    </option>
                  ))}
                </NativeSelect>
              </FieldShell>
            );
          }

          case 'multiselect': {
            const selected = Array.isArray(field.value) ? field.value : [];
            return (
              <FieldShell {...shell} group>
                <div className="flex flex-wrap gap-2">
                  {optionCodes(property).map((code, index) => (
                    <ChoiceChip
                      key={code}
                      type="checkbox"
                      name={field.name}
                      value={code}
                      label={optionLabel(schema, fieldKey, code, locale)}
                      checked={selected.includes(code)}
                      onChange={(e) =>
                        field.onChange(
                          e.target.checked
                            ? [...selected, code]
                            : selected.filter((item) => item !== code),
                        )
                      }
                      onBlur={field.onBlur}
                      ref={index === 0 ? field.ref : undefined}
                    />
                  ))}
                </div>
              </FieldShell>
            );
          }
        }
      }}
    />
  );
}
