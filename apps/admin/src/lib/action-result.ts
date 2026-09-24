/**
 * What a Server Action hands back to the client. Failures are returned, not
 * thrown: an error thrown across the action boundary reaches the browser
 * stripped of its class and message in production, so the client could never
 * say *why* something failed. `messageKey` is a key under `apiError`.
 */
export type ActionResult = { ok: true } | { ok: false; messageKey: string };
