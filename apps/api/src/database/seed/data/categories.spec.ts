import {
  checkPublishable,
  compileFieldsValidator,
  parseFieldDefinition,
  resolveFieldDefinition,
  type FieldsValidationContext,
} from '../../../categories/field-schema';
import { rngFor } from '../ids';
import { CATEGORIES } from './categories';
import { authoredDefinitionOf, definitionOf } from './category-dsl';
import { sampleFields } from './category-samples';

/**
 * The seeded taxonomy must match docs/specs/categories.md and pass the same
 * publish check a platform admin's schema goes through, because a published
 * schema can never be edited afterwards.
 */

const context: FieldsValidationContext = { today: '2026-09-24', currentYear: 2026 };
const withSchema = CATEGORIES.filter((c) => c.kind !== 'module');

describe('seed taxonomy (categories.md)', () => {
  it('has the 27 categories, with unique slugs', () => {
    expect(CATEGORIES).toHaveLength(27);
    expect(new Set(CATEGORIES.map((c) => c.slug)).size).toBe(27);
  });

  it('enables exactly the five phase-1 categories', () => {
    expect(CATEGORIES.filter((c) => c.phase1).map((c) => c.slug)).toEqual([
      'to-let',
      'buy-sell',
      'on-demand-service',
      'local-shop-directory',
      'emergency-numbers',
    ]);
  });

  it('lists every parent before its children, with the same kind', () => {
    CATEGORIES.forEach((c, index) => {
      if (c.parent === undefined) return;
      const parentIndex = CATEGORIES.findIndex((p) => p.slug === c.parent);
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(index);
      expect(CATEGORIES[parentIndex]!.kind).toBe(c.kind);
    });
  });

  it('matches the 0017 constraints for module tiles, places and expiry', () => {
    for (const c of CATEGORIES) {
      expect(c.moduleCode !== undefined).toBe(c.kind === 'module');
      if (c.kind === 'module') {
        expect(c.fields).toEqual([]);
        expect(c.parent).toBeUndefined();
        expect(c.costCredits).toBe(0);
      }
      if (c.kind === 'module' || c.kind === 'place') expect(c.expiryDays).toBeNull();
      else expect(c.expiryDays).toBeGreaterThan(0);
    }
  });

  it.each(withSchema.map((c) => [c.slug, c] as const))('%s passes the publish check', (_, c) => {
    expect(() => checkPublishable(definitionOf(c, CATEGORIES))).not.toThrow();
  });

  it.each(withSchema.map((c) => [c.slug, c] as const))(
    '%s sample fields validate against its schema',
    (slug, c) => {
      const { jsonSchema } = definitionOf(c, CATEGORIES);
      const fields = sampleFields(jsonSchema, context, rngFor(`spec:${slug}`), slug);
      const result = compileFieldsValidator(jsonSchema, context).safeParse(fields);
      expect(result.success ? [] : result.error.issues).toEqual([]);
    },
  );

  it.each(withSchema.map((c) => [c.slug, c] as const))(
    '%s authored definition survives JSON storage and re-resolves to the published one',
    (_, c) => {
      const stored = parseFieldDefinition(JSON.parse(JSON.stringify(authoredDefinitionOf(c))));
      const parent = CATEGORIES.find((p) => p.slug === c.parent);
      const resolved = resolveFieldDefinition(
        stored,
        parent ? definitionOf(parent, CATEGORIES) : undefined,
      );
      expect(resolved).toEqual(definitionOf(c, CATEGORIES));
    },
  );

  it('merges buy-sell fields into its children and applies narrowing', () => {
    const vehicles = definitionOf(
      CATEGORIES.find((c) => c.slug === 'second-hand-vehicles')!,
      CATEGORIES,
    );
    expect(vehicles.jsonSchema.properties.price).toBeDefined();
    expect(vehicles.jsonSchema.required).toEqual(expect.arrayContaining(['price', 'condition']));
    expect(vehicles.jsonSchema.properties.condition).toMatchObject({ enum: ['used', 'for_parts'] });
    expect(vehicles.uiSchema.hidden).toEqual(['home_delivery']);
    expect(vehicles.filterableFields).not.toContain('home_delivery');
  });
});
