import { NextResponse } from 'next/server';
import { ApiError, ApiShapeError, ApiUnreachableError } from './errors';

/**
 * A route handler's failure, as the browser sees it: the API's error code and
 * details (for a specific Bengali message) — never its English text, a stack
 * or an internal URL.
 */
export function routeError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { code: error.code, details: error.details ?? null },
      { status: error.status },
    );
  }
  if (error instanceof ApiUnreachableError) {
    return NextResponse.json({ code: 'API_UNREACHABLE' }, { status: 503 });
  }
  if (error instanceof ApiShapeError) {
    return NextResponse.json({ code: 'UNEXPECTED_RESPONSE' }, { status: 502 });
  }
  throw error;
}
