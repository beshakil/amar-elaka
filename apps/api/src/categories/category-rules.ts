import { sqlStateOf } from '../common/utils/sql-state';
import {
  CategoryRuleViolationException,
  CategorySlugTakenException,
} from './categories.exceptions';
import type { CategoryRow } from './categories.repository';
import type { CategoryKind, ModuleCode } from './categories.types';

/**
 * The category-shape rules the database enforces (0004, 0017), checked up
 * front so the admin gets a precise, stable issue code instead of a generic
 * failure. The database constraints stay the source of truth: anything that
 * slips past these checks is still rejected there and mapped by
 * `mapCategoryWriteError`.
 */

export const CATEGORY_ISSUES = {
  moduleCodeMismatch: 'category.module_code_mismatch',
  moduleTileShape: 'category.module_tile_shape',
  expiryNotAllowed: 'category.expiry_not_allowed',
  parentNotFound: 'category.parent_not_found',
  parentKindMismatch: 'category.parent_kind_mismatch',
  parentCycle: 'category.parent_cycle',
  inactive: 'category.inactive',
  noPostOverrides: 'category.no_post_overrides',
  moderationCannotLoosen: 'category.moderation_cannot_loosen',
  moduleTileExists: 'category.module_tile_exists',
  ruleViolation: 'category.rule_violation',
} as const;

export interface CategoryShape {
  id?: string;
  kind: CategoryKind;
  moduleCode: ModuleCode | null;
  parentId: string | null;
  postCostCredits: number;
  postExpiryDays: number | null;
}

/**
 * `ancestorsOf(parentId)` returns the parent chain (parent first), or
 * undefined when the parent doesn't exist.
 */
export function categoryShapeIssues(
  shape: CategoryShape,
  parent: CategoryRow | undefined,
  ancestorIds: readonly string[],
): string[] {
  const issues: string[] = [];
  const isModule = shape.kind === 'module';
  if (isModule !== (shape.moduleCode !== null)) issues.push(CATEGORY_ISSUES.moduleCodeMismatch);
  if (isModule && (shape.parentId !== null || shape.postCostCredits !== 0)) {
    issues.push(CATEGORY_ISSUES.moduleTileShape);
  }
  if ((isModule || shape.kind === 'place') && shape.postExpiryDays !== null) {
    issues.push(CATEGORY_ISSUES.expiryNotAllowed);
  }
  if (shape.parentId !== null) {
    if (parent === undefined) issues.push(CATEGORY_ISSUES.parentNotFound);
    else if (parent.kind !== shape.kind) issues.push(CATEGORY_ISSUES.parentKindMismatch);
    if (shape.id !== undefined && (shape.parentId === shape.id || ancestorIds.includes(shape.id))) {
      issues.push(CATEGORY_ISSUES.parentCycle);
    }
  }
  return issues;
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

function constraintOf(error: unknown): string | undefined {
  for (let current: unknown = error; current;) {
    if (typeof current === 'object' && 'constraint_name' in current) {
      return typeof current.constraint_name === 'string' ? current.constraint_name : undefined;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Maps a constraint failure to a typed exception; never forwards the driver message. */
export function mapCategoryWriteError(error: unknown): unknown {
  const state = sqlStateOf(error);
  if (state === UNIQUE_VIOLATION) {
    return constraintOf(error) === 'categories_module_code_uq'
      ? new CategoryRuleViolationException([CATEGORY_ISSUES.moduleTileExists])
      : new CategorySlugTakenException();
  }
  if (state === CHECK_VIOLATION) {
    return new CategoryRuleViolationException([CATEGORY_ISSUES.ruleViolation]);
  }
  return error;
}
