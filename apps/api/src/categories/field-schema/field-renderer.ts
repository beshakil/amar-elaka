import type { CategoryFieldDefinition } from './field-schema.flatten';
import type { FieldType, LocalizedText } from './field-schema.types';
import type { FieldValue, FieldValues } from './fields-validator';

/**
 * Turns stored `fields` into labelled values using the schema version the
 * post pinned (`posts.field_schema_id`), never the category's current one.
 * That's what keeps a v1 post readable after v2 adds, renames or removes a
 * field: its own version still has every label and option it used.
 */

export interface RenderedField {
  key: string;
  type: FieldType;
  label: LocalizedText;
  value: FieldValue;
  /** Option labels for select / multiselect values, in value order. */
  optionLabels?: LocalizedText[];
}

export function renderFields(
  definition: Pick<CategoryFieldDefinition, 'jsonSchema' | 'uiSchema'>,
  values: FieldValues,
): RenderedField[] {
  const { jsonSchema, uiSchema } = definition;
  const rendered: RenderedField[] = [];

  for (const key of uiSchema.order) {
    const property = jsonSchema.properties[key];
    const value = values[key];
    const label = uiSchema.labels[key];
    if (property === undefined || value === undefined || label === undefined) continue;

    const options = uiSchema.options?.[key] ?? {};
    const codes = Array.isArray(value) ? value : [value];
    const optionLabels =
      property['x-field-type'] === 'select' || property['x-field-type'] === 'multiselect'
        ? codes.flatMap((code) => {
            const option = typeof code === 'string' ? options[code] : undefined;
            return option ? [option] : [];
          })
        : undefined;

    rendered.push({
      key,
      type: property['x-field-type'],
      label,
      value,
      ...(optionLabels ? { optionLabels } : {}),
    });
  }
  return rendered;
}
