/** A primitive as text; anything else (an object, null) as ''. For values from JSON. */
export function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}
