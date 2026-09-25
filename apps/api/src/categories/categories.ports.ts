/** Injectable time source, so "today" in field validation is testable. */
export interface CategoriesClock {
  now(): number;
}

export const CATEGORIES_CLOCK = Symbol('CATEGORIES_CLOCK');

export const systemCategoriesClock: CategoriesClock = { now: () => Date.now() };
