import { ApiError, ApiShapeError, ApiUnreachableError } from './fetch';

/**
 * Maps a failure to a key under the `apiError` messages, so every screen shows
 * the same Bengali sentence for the same cause and no component invents copy.
 * The API's own `error` field is a DomainException code, which is what the
 * known codes below are.
 */
export function apiErrorMessageKey(error: unknown): string {
  if (error instanceof ApiUnreachableError) return 'unreachable';
  if (error instanceof ApiShapeError) return 'unexpected';
  if (!(error instanceof ApiError)) return 'unexpected';

  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return 'invalidCredentials';
    case 'UNAUTHENTICATED':
      return 'unauthenticated';
    case 'ACCOUNT_RESTRICTED':
    case 'ACCOUNT_BANNED':
    case 'ACCOUNT_TERMINATED':
      return 'accountRestricted';
    case 'PERMISSION_DENIED':
    case 'PLATFORM_ACCESS_REQUIRED':
      return 'permissionDenied';
    case 'TENANT_REQUIRED':
    case 'TENANT_NOT_FOUND':
    case 'TENANT_CONTEXT_MISSING':
    case 'TENANT_ID_INVALID':
      return 'tenantRequired';
    case 'TENANT_MISMATCH':
      return 'tenantMismatch';
    case 'TENANT_SUSPENDED':
    case 'TENANT_TERMINATED':
      return 'tenantUnavailable';
    case 'ROLE_ALREADY_EXISTS':
      return 'roleAlreadyExists';
    case 'ROLE_BUILTIN_IMMUTABLE':
      return 'roleBuiltinImmutable';
    case 'ROLE_NOT_FOUND':
      return 'roleNotFound';
    case 'VALIDATION_FAILED':
      return 'validationFailed';
    default:
      return error.status >= 500 ? 'server' : 'unexpected';
  }
}
