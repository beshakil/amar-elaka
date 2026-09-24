import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import { DomainException } from '../exceptions/domain-exception';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Nest's built-in HttpExceptions carry a plain message. Library-generated
 * ones (e.g. Terminus's ServiceUnavailableException for /health/ready) carry
 * a structured body instead — `{ status, info, error, details }`, with no
 * `message` at all. Both are safe to forward as-is; neither ever contains a
 * stack trace or raw driver/SQL output (health indicators only ever put
 * `{ status, message: 'unreachable' }` literals in there — see
 * PostgresHealthIndicator et al).
 */
function httpExceptionBody(exception: HttpException): { message: string; details?: unknown } {
  const response = exception.getResponse();
  if (!isRecord(response)) {
    return { message: typeof response === 'string' ? response : exception.message };
  }

  const { message, statusCode: _statusCode, ...rest } = response;
  const resolvedMessage = Array.isArray(message)
    ? message.join(', ')
    : ((message as string | undefined) ?? exception.message);
  const details = Object.keys(rest).length > 0 ? rest : undefined;

  return { message: resolvedMessage, details };
}

/**
 * Catches everything. Domain exceptions and Nest's own HttpExceptions carry
 * client-safe messages through as-is; anything else (DB errors, unhandled
 * bugs, etc.) is collapsed to a generic 500 — the real error is only ever
 * logged, never sent to the client.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const body = this.toErrorBody(exception);

    this.logger.error(
      { err: exception, path: request.url, method: request.method, statusCode: body.statusCode },
      body.error,
    );

    void response.status(body.statusCode).send(body);
  }

  private toErrorBody(exception: unknown): ErrorBody {
    if (exception instanceof DomainException) {
      return {
        statusCode: exception.httpStatus,
        error: exception.code,
        message: exception.message,
        details: 'issues' in exception ? (exception as { issues: unknown }).issues : undefined,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const { message, details } = httpExceptionBody(exception);
      return {
        statusCode: status,
        error: HttpStatus[status] ?? 'HTTP_ERROR',
        message,
        details,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
    };
  }
}
