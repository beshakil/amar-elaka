import type { FieldSchema, UiSchema } from './field-schema.types';
import { renderFields } from './field-renderer';

describe('renderFields', () => {
  const jsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: {
      specialty: { 'x-field-type': 'text', type: 'string' },
      serial_phone: { 'x-field-type': 'phone', type: 'string' },
    },
  } as unknown as FieldSchema;
  const uiSchema = {
    order: ['specialty', 'serial_phone'],
    card: [],
    labels: {
      specialty: { bn: 'বিশেষজ্ঞতা', en: 'Specialty' },
      serial_phone: { bn: 'সিরিয়ালের নম্বর', en: 'Serial booking number' },
    },
  } as unknown as UiSchema;

  it('renders fields in order with their labels', () => {
    const rendered = renderFields({ jsonSchema, uiSchema }, { specialty: 'মেডিসিন' });
    expect(rendered).toEqual([
      { key: 'specialty', type: 'text', label: uiSchema.labels.specialty, value: 'মেডিসিন' },
    ]);
  });

  it('never renders a phone field: a number leaves only through the contact endpoint', () => {
    const rendered = renderFields(
      { jsonSchema, uiSchema },
      { specialty: 'মেডিসিন', serial_phone: '+8801711000000' },
    );
    expect(rendered.map((f) => f.key)).toEqual(['specialty']);
    expect(JSON.stringify(rendered)).not.toContain('01711000000');
  });
});
