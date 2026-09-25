import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantDb } from '../database/tenant-db';
import {
  CategoryNotFoundException,
  CategoryNotPostableException,
  FieldSchemaNotFoundException,
  FieldValidationException,
} from './categories.exceptions';
import { CategoriesRepository, type FieldSchemaRow } from './categories.repository';
import { POSTABLE_KINDS } from './categories.types';
import { CATEGORIES_CLOCK, type CategoriesClock } from './categories.ports';
import {
  compileFieldsValidator,
  fieldIssuesOf,
  FIELD_ISSUES,
  parseFieldSchema,
  validationContextAt,
  type FieldValues,
  type FieldsValidationContext,
} from './field-schema';

export interface ValidatedFields {
  categoryId: string;
  /** The version the post must pin (`posts.field_schema_id`). */
  fieldSchemaId: string;
  fieldSchemaVersion: number;
  /** Normalised values (trimmed text) to store in `posts.fields`. */
  values: FieldValues;
}

/**
 * Validates a post's custom fields (schema.md §4.2: mandatory on every post
 * create/update, before any SQL write). New posts and edits validate against
 * the category's *current* version and re-pin to it; the stored row always
 * matches the version it names.
 *
 * Compiled validators are cached per schema id: published and retired
 * versions never change (0018), so a cached validator can't go stale. The
 * cache is also keyed by the tenant's calendar day, because "not before
 * today" and "up to the current year" rules depend on it, and is emptied
 * when the day changes, so it holds at most one entry per version.
 */
@Injectable()
export class FieldValidationService {
  private cacheDay = '';
  private readonly validators = new Map<string, z.ZodType<FieldValues>>();

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly repo: CategoriesRepository,
    private readonly tenantContext: TenantContext,
    @Inject(CATEGORIES_CLOCK) private readonly clock: CategoriesClock,
  ) {}

  /** For a new post, or an edit that moves the post to the current version. */
  validate(categoryId: string, payload: unknown): Promise<ValidatedFields> {
    const tenantId = this.tenantContext.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();

    return this.tenantDb.transaction(
      async (tx) => {
        const category = await this.repo.findById(tx, categoryId);
        if (!category) throw new CategoryNotFoundException();
        const enabled = (await this.repo.listTenantRows(tx, tenantId)).some(
          (row) => row.categoryId === categoryId && row.isEnabled,
        );
        const schema = await this.repo.findSchema(tx, categoryId, 'published');
        if (!category.isActive || !POSTABLE_KINDS.has(category.kind) || !enabled || !schema) {
          throw new CategoryNotPostableException();
        }
        const values = this.check(schema, payload, await this.contextFor(tx, tenantId));
        return {
          categoryId,
          fieldSchemaId: schema.id,
          fieldSchemaVersion: schema.version,
          values,
        };
      },
      { accessMode: 'read only' },
    );
  }

  /**
   * Validates against one specific version, e.g. to confirm a stored post is
   * still valid under the version it pinned. Drafts are never a target.
   */
  validateAgainstVersion(fieldSchemaId: string, payload: unknown): Promise<FieldValues> {
    const tenantId = this.tenantContext.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();

    return this.tenantDb.transaction(
      async (tx) => {
        const schema = await this.repo.findSchemaById(tx, fieldSchemaId);
        if (!schema || schema.status === 'draft') throw new FieldSchemaNotFoundException();
        return this.check(schema, payload, await this.contextFor(tx, tenantId));
      },
      { accessMode: 'read only' },
    );
  }

  private check(
    schema: FieldSchemaRow,
    payload: unknown,
    context: FieldsValidationContext,
  ): FieldValues {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new FieldValidationException([{ field: '', code: FIELD_ISSUES.invalid }]);
    }
    const result = this.validatorFor(schema, context).safeParse(payload);
    if (result.success) return result.data;

    throw new FieldValidationException(fieldIssuesOf(result.error));
  }

  private validatorFor(
    schema: FieldSchemaRow,
    context: FieldsValidationContext,
  ): z.ZodType<FieldValues> {
    const day = `${context.today}|${context.currentYear}`;
    if (day !== this.cacheDay) {
      this.validators.clear();
      this.cacheDay = day;
    }
    let validator = this.validators.get(schema.id);
    if (!validator) {
      validator = compileFieldsValidator(parseFieldSchema(schema.jsonSchema), context);
      this.validators.set(schema.id, validator);
    }
    return validator;
  }

  private async contextFor(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<FieldsValidationContext> {
    const timeZone = await this.repo.tenantTimeZone(tx, tenantId);
    if (!timeZone) throw new TenantRequiredException();
    return validationContextAt(new Date(this.clock.now()), timeZone);
  }
}
