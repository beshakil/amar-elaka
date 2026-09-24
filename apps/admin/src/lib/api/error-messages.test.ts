import { describe, expect, it } from 'vitest';
import messages from '../../messages/bn.json';
import { apiErrorMessageKey } from './error-messages';
import { ApiError, ApiShapeError, ApiUnreachableError } from './fetch';

describe('apiErrorMessageKey', () => {
  it.each([
    ['INVALID_CREDENTIALS', 'invalidCredentials'],
    ['ACCOUNT_BANNED', 'accountRestricted'],
    ['PERMISSION_DENIED', 'permissionDenied'],
    ['TENANT_MISMATCH', 'tenantMismatch'],
    ['ROLE_ALREADY_EXISTS', 'roleAlreadyExists'],
    ['ROLE_BUILTIN_IMMUTABLE', 'roleBuiltinImmutable'],
    ['ROLE_NOT_FOUND', 'roleNotFound'],
    ['VALIDATION_FAILED', 'validationFailed'],
  ])('maps %s to %s', (code, key) => {
    expect(apiErrorMessageKey(new ApiError(400, code, 'x'))).toBe(key);
  });

  it('separates an unknown server failure from an unknown client one', () => {
    expect(apiErrorMessageKey(new ApiError(502, 'SOMETHING_NEW', 'x'))).toBe('server');
    expect(apiErrorMessageKey(new ApiError(418, 'SOMETHING_NEW', 'x'))).toBe('unexpected');
  });

  it('maps transport and shape failures', () => {
    expect(apiErrorMessageKey(new ApiUnreachableError())).toBe('unreachable');
    expect(apiErrorMessageKey(new ApiShapeError('/x'))).toBe('unexpected');
    expect(apiErrorMessageKey(new Error('anything'))).toBe('unexpected');
  });

  it('only ever returns keys that exist in the Bengali catalog', () => {
    const codes = [
      'INVALID_CREDENTIALS',
      'UNAUTHENTICATED',
      'ACCOUNT_RESTRICTED',
      'PERMISSION_DENIED',
      'TENANT_REQUIRED',
      'TENANT_MISMATCH',
      'TENANT_SUSPENDED',
      'ROLE_ALREADY_EXISTS',
      'ROLE_BUILTIN_IMMUTABLE',
      'ROLE_NOT_FOUND',
      'VALIDATION_FAILED',
      'OTHER',
    ];
    const keys = [
      ...codes.flatMap((code) => [new ApiError(400, code, ''), new ApiError(500, code, '')]),
      new ApiUnreachableError(),
    ].map(apiErrorMessageKey);
    for (const key of keys) expect(messages.apiError).toHaveProperty(key);
  });
});
