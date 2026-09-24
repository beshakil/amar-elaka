/** Walks `error.cause` chains for a Postgres error's SQLSTATE code (e.g. '40001', '23505', or a custom 'AE0xx' from a PL/pgSQL RAISE). */
export function sqlStateOf(error: unknown): string | undefined {
  for (let current: unknown = error; current;) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
