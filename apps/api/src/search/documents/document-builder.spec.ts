import type { FieldSchema, UiSchema } from '../../categories/field-schema';
import { SYNONYM_LINES } from '../synonyms/search-synonyms.generated';
import { SearchTerms } from '../text/search-terms';
import {
  cardFields,
  fieldText,
  indexedFields,
  postDocument,
  storeDocument,
  type PostRow,
} from './document-builder';

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    property_type: { 'x-field-type': 'select', type: 'string', enum: ['flat', 'house'] },
    bedrooms: { 'x-field-type': 'number', type: 'integer' },
    price: { 'x-field-type': 'money', type: 'string' },
    available_from: { 'x-field-type': 'date', type: 'string', format: 'date' },
    has_lift: { 'x-field-type': 'bool', type: 'boolean' },
    trip_types: {
      'x-field-type': 'multiselect',
      type: 'array',
      items: { type: 'string', enum: ['local'] },
    },
    notes: { 'x-field-type': 'textarea', type: 'string' },
  },
} as unknown as FieldSchema;

const uiSchema = {
  order: [],
  card: ['bedrooms', 'price', 'missing'],
  labels: {},
  options: { property_type: { flat: { bn: 'ফ্ল্যাট', en: 'Flat' } } },
} as unknown as UiSchema;

const row: PostRow = {
  id: 'p1',
  tenant_id: 't1',
  title: 'মিরপুরে ফ্ল্যাট ভাড়া',
  description: '  আলো-বাতাস ভালো‌ ',
  price: '15000.00',
  category_id: 'c1',
  category_slug: 'to-let',
  category_name_bn: 'টু-লেট',
  category_name_en: 'To-Let',
  locality_id: 'l1',
  area_name_bn: 'মিরপুর ১০',
  area_name_en: 'Mirpur 10',
  lat: 23.8069,
  lng: 90.3687,
  published_at: 1_790_000_000,
  is_boosted: true,
  cover_thumb_key: 't1/image/x.thumb.webp',
  cover_thumbhash: 'abc=',
  rating_avg: null,
  json_schema: jsonSchema,
  ui_schema: uiSchema,
  filterable_fields: [
    'property_type',
    'bedrooms',
    'price',
    'available_from',
    'has_lift',
    'trip_types',
    'notes',
  ],
  searchable_fields: ['property_type'],
  fields: {
    property_type: 'flat',
    bedrooms: 3,
    price: '15000.00',
    available_from: '2026-10-01',
    has_lift: true,
    trip_types: ['local'],
    notes: 'not filterable text',
  },
};

describe('document builder', () => {
  const terms = new SearchTerms(SYNONYM_LINES);

  it('indexes custom fields in filterable forms: money in poisha, dates as yyyymmdd', () => {
    expect(indexedFields(row)).toEqual({
      property_type: 'flat',
      bedrooms: 3,
      price: 1_500_000,
      available_from: 20261001,
      has_lift: true,
      trip_types: ['local'],
    });
  });

  it('skips values of the wrong type instead of failing (older schema versions)', () => {
    expect(
      indexedFields({ ...row, fields: { bedrooms: 'three', price: 15000, has_lift: 'yes' } }),
    ).toEqual({});
  });

  it('turns searchable select values into both labels, and keeps card fields as stored', () => {
    expect(fieldText(row)).toBe('ফ্ল্যাট Flat');
    expect(cardFields(row)).toEqual({ bedrooms: 3, price: '15000.00' });
  });

  it('builds a post document', () => {
    const doc = postDocument(row, terms);
    expect(doc).toMatchObject({
      id: 'p1',
      tenant_id: 't1',
      name_bn: 'মিরপুরে ফ্ল্যাট ভাড়া',
      name_en: null,
      name_translit: 'mirpure phlyat bhara',
      description: 'আলো-বাতাস ভালো',
      category_slug: 'to-let',
      category_translit: 'tu let',
      area_translit: 'mirpur 10',
      _geo: { lat: 23.8069, lng: 90.3687 },
      is_boosted: 1,
      published_at: 1_790_000_000,
      price_minor: 1_500_000,
      slug: null,
    });
    expect(doc.name_variants).toEqual(expect.arrayContaining(['flat', 'rent', 'vara']));
    // Every Bengali word of the searchable text also appears in Latin.
    expect(doc.text_translit).toBe('phlyat alo batas bhalo');
  });

  it('leaves _geo null without a point, and price null without a price', () => {
    const doc = postDocument(
      { ...row, lat: null, lng: null, price: null, is_boosted: false },
      terms,
    );
    expect(doc._geo).toBeNull();
    expect(doc.price_minor).toBeNull();
    expect(doc.is_boosted).toBe(0);
  });

  it('builds a store document from both name columns', () => {
    const doc = storeDocument(
      {
        ...row,
        name_bn: 'রহিম ফার্মেসি',
        name_en: 'Rahim Pharmacy',
        slug: 'rahim-pharmacy',
        is_verified: true,
        rating_avg: '4.50',
        json_schema: null,
        ui_schema: null,
        filterable_fields: [],
        searchable_fields: [],
        fields: {},
      },
      terms,
    );
    expect(doc).toMatchObject({
      name_bn: 'রহিম ফার্মেসি',
      name_en: 'Rahim Pharmacy',
      slug: 'rahim-pharmacy',
      is_verified: true,
      rating_avg: 4.5,
      fields: {},
      price_minor: null,
    });
    // "pharmacy" is already searchable in name_en, so it isn't repeated as a variant.
    expect(doc.name_variants).toContain('farmesi');
    expect(doc.name_variants).not.toContain('pharmacy');
  });
});
