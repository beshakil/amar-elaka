import { z } from 'zod';

/** The shape GlobalExceptionFilter sends for every non-2xx response. */
const errorBodySchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The API's `error` field — a DomainException code like OTP_EXPIRED. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A request that never got an answer: DNS, connection reset, timeout. */
export class ApiUnreachableError extends Error {
  constructor(cause?: unknown) {
    super('The API could not be reached.', { cause });
    this.name = 'ApiUnreachableError';
  }
}

/** A 2xx body that did not match the schema the caller expected. */
export class ApiShapeError extends Error {
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    super(`Unexpected response shape from ${path}.`, { cause });
    this.name = 'ApiShapeError';
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success
    ? new ApiError(response.status, parsed.data.error, parsed.data.message)
    : new ApiError(response.status, 'UNKNOWN_ERROR', response.statusText);
}
