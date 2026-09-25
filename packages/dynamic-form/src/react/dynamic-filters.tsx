'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId } from 'react';
import {
  activeFilterCount,
  filterControlOf,
  filterFieldKeys,
  toRawFilters,
  type FilterIssue,
  type FilterState,
  type RangeState,
  type RawFieldFilter,
} from '../filters';
import { formatMoney, localizeDigits, parseMoneyInput, parseNumberInput } from '../numerals';
import {
  labelOf,
  optionCodes,
  optionLabel,
  type CategoryFieldSchema,
  type FieldProperty,
  type Locale,
} from '../schema';
import { PrefixedInput, Switch, TextInput, ToggleChip, cn } from './primitives';

/**
 * The filter panel for a category, driven by the same field schema as the
 * form: number/money/date -> a min–max range, select/multiselect -> toggle
 * chips, bool -> a switch, short text -> exact match. Controlled: the parent
 * owns the state (e.g. mirrored in the URL with filtersToSearchParams) and
 * gets the API filters plus any problems on every change.
 */
export interface DynamicFiltersProps {
  schema: CategoryFieldSchema;
  value: FilterState;
  onChange: (
    value: FilterState,
    result: { filters: RawFieldFilter[]; issues: FilterIssue[] },
  ) => void;
  onApply?: (filters: RawFieldFilter[]) => void;
  locale?: Locale;
  className?: string;
}

type TranslateDynamic = (id: string, values?: Record<string, string | number>) => string;

export function DynamicFilters({
  schema,
  value,
  onChange,
  onApply,
  locale: localeProp,
  className,
}: DynamicFiltersProps) {
  const intlLocale = useLocale();
  const locale: Locale = localeProp ?? (intlLocale === 'en' ? 'en' : 'bn');
  const t = useTranslations('dynamicForm') as unknown as TranslateDynamic;
  const baseId = useId();
  const keys = filterFieldKeys(schema);
  const { filters, issues } = toRawFilters(schema, value);
  const active = activeFilterCount(schema, value);

  const update = (key: string, next: FilterState[string]) => {
    const state = { ...value, [key]: next };
    onChange(state, toRawFilters(schema, state));
  };

  if (keys.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('ui.noFilterableFields')}</p>;
  }

  return (
    <section className={cn('space-y-5', className)} aria-labelledby={`${baseId}-status`}>
      <div className="flex items-center justify-between gap-3">
        <p id={`${baseId}-status`} aria-live="polite" className="text-sm font-medium">
          {t('ui.activeFilters', { count: active })}
        </p>
        {active > 0 && (
          <button
            type="button"
            onClick={() => onChange({}, toRawFilters(schema, {}))}
            className="text-sm text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('ui.clearFilters')}
          </button>
        )}
      </div>

      {keys.map((key) => {
        const property = schema.jsonSchema.properties[key]!;
        const id = `${baseId}-${key}`;
        const label = labelOf(schema, key, locale);
        const fieldIssues = issues.filter((issue) => issue.field === key);
        const errorText = fieldIssues.map((issue) => t(issue.id)).join(' ');

        switch (filterControlOf(property)) {
          case 'range':
            return (
              <RangeFilter
                key={key}
                id={id}
                label={label}
                property={property}
                locale={locale}
                value={(value[key] as RangeState | undefined) ?? {}}
                invalid={new Set(fieldIssues.map((i) => i.bound))}
                error={errorText}
                t={t}
                onChange={(range) => update(key, range)}
              />
            );
          case 'chips': {
            const selected = Array.isArray(value[key]) ? value[key] : [];
            return (
              <fieldset key={key} className="space-y-2">
                <legend className="mb-1 text-sm font-medium">{label}</legend>
                <div className="flex flex-wrap gap-2">
                  {optionCodes(property).map((code) => {
                    const pressed = selected.includes(code);
                    return (
                      <ToggleChip
                        key={code}
                        pressed={pressed}
                        onClick={() =>
                          update(
                            key,
                            pressed ? selected.filter((c) => c !== code) : [...selected, code],
                          )
                        }
                      >
                        {optionLabel(schema, key, code, locale)}
                      </ToggleChip>
                    );
                  })}
                </div>
              </fieldset>
            );
          }
          case 'toggle':
            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <label htmlFor={id} className="text-sm font-medium">
                  {label}
                </label>
                <Switch
                  id={id}
                  checked={value[key] === true}
                  onCheckedChange={(checked) => update(key, checked)}
                />
              </div>
            );
          case 'text':
            return (
              <div key={key} className="space-y-1.5">
                <label htmlFor={id} className="block text-sm font-medium">
                  {label}
                </label>
                <TextInput
                  id={id}
                  value={typeof value[key] === 'string' ? value[key] : ''}
                  onChange={(e) => update(key, e.target.value)}
                />
              </div>
            );
          default:
            return null;
        }
      })}

      {onApply && (
        <button
          type="button"
          disabled={issues.length > 0}
          onClick={() => onApply(filters)}
          className="inline-flex h-11 w-full items-center justify-center rounded-md bg-brand px-5 text-sm font-medium text-brand-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {t('ui.applyFilters')}
        </button>
      )}
    </section>
  );
}

function RangeFilter({
  id,
  label,
  property,
  locale,
  value,
  invalid,
  error,
  t,
  onChange,
}: {
  id: string;
  label: string;
  property: FieldProperty;
  locale: Locale;
  value: RangeState;
  invalid: Set<'min' | 'max' | undefined>;
  error: string;
  t: TranslateDynamic;
  onChange: (value: RangeState) => void;
}) {
  const type = property['x-field-type'];
  const isInteger = type === 'number' && property.type === 'integer';

  /** Tidies a bound on blur: Bengali digits, grouped money. */
  const tidy = (raw: string | undefined): string | undefined => {
    if (raw === undefined || raw.trim() === '') return raw;
    if (type === 'money') {
      const parsed = parseMoneyInput(raw);
      return parsed === undefined ? raw : formatMoney(parsed, locale);
    }
    if (type === 'number') {
      const parsed = parseNumberInput(raw);
      return Number.isNaN(parsed) ? raw : localizeDigits(String(parsed), locale);
    }
    return raw;
  };

  const bound = (which: 'min' | 'max') => {
    const inputId = `${id}-${which}`;
    const props = {
      id: inputId,
      value: value[which] ?? '',
      'aria-label': t('ui.rangeLabel', { label, bound: t(`ui.${which}`) }),
      'aria-invalid': invalid.has(which) || undefined,
      'aria-describedby': error ? `${id}-error` : undefined,
      placeholder: t(`ui.${which}`),
      onChange: (e: { target: { value: string } }) =>
        onChange({ ...value, [which]: e.target.value }),
      onBlur: () => onChange({ ...value, [which]: tidy(value[which]) }),
    };
    if (type === 'date') return <TextInput {...props} type="date" lang={locale} />;
    if (type === 'money') {
      return (
        <PrefixedInput {...props} prefix="৳" type="text" inputMode="decimal" autoComplete="off" />
      );
    }
    return (
      <TextInput
        {...props}
        type="text"
        inputMode={isInteger ? 'numeric' : 'decimal'}
        autoComplete="off"
      />
    );
  };

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        {bound('min')}
        {bound('max')}
      </div>
      <p id={`${id}-error`} aria-live="polite" className="text-sm text-destructive empty:hidden">
        {error}
      </p>
    </fieldset>
  );
}
