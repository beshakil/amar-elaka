import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain-exception';

// --- OTP -----------------------------------------------------------------

export class OtpCooldownException extends DomainException {
  readonly code = 'OTP_RATE_LIMITED_COOLDOWN';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;
  constructor() {
    super('Please wait before requesting another OTP.');
  }
}

export class OtpPhoneDailyLimitException extends DomainException {
  readonly code = 'OTP_RATE_LIMITED_PHONE_DAILY';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;
  constructor() {
    super('This phone number has requested too many OTPs today.');
  }
}

export class OtpIpDailyLimitException extends DomainException {
  readonly code = 'OTP_RATE_LIMITED_IP_DAILY';
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;
  constructor() {
    super('Too many OTP requests from this network today.');
  }
}

export class OtpExpiredException extends DomainException {
  readonly code = 'OTP_EXPIRED';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('This OTP has expired. Please request a new one.');
  }
}

export class OtpIncorrectException extends DomainException {
  readonly code = 'OTP_INCORRECT';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor(readonly attemptsRemaining: number) {
    super('The OTP code is incorrect.');
  }
}

export class OtpTooManyAttemptsException extends DomainException {
  readonly code = 'OTP_TOO_MANY_ATTEMPTS';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('Too many incorrect attempts. Please request a new OTP.');
  }
}

// --- Account state ---------------------------------------------------------

export class AccountRestrictedException extends DomainException {
  readonly code = 'ACCOUNT_RESTRICTED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('This account is restricted. Contact support for help.');
  }
}

export class AccountBannedException extends DomainException {
  readonly code = 'ACCOUNT_BANNED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('This account has been banned.');
  }
}

export class AccountTerminatedException extends DomainException {
  readonly code = 'ACCOUNT_TERMINATED';
  readonly httpStatus = HttpStatus.FORBIDDEN;
  constructor() {
    super('This account has been terminated.');
  }
}

// --- Credentials -------------------------------------------------------------

export class InvalidCredentialsException extends DomainException {
  readonly code = 'INVALID_CREDENTIALS';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;
  constructor() {
    super('Invalid email or password.');
  }
}

export class WeakPasswordException extends DomainException {
  readonly code = 'WEAK_PASSWORD';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor(readonly minLength: number) {
    super(`Password must be at least ${minLength} characters.`);
  }
}

export class EmailAlreadyRegisteredException extends DomainException {
  readonly code = 'EMAIL_ALREADY_REGISTERED';
  readonly httpStatus = HttpStatus.CONFLICT;
  constructor() {
    super('This email is already registered to another account.');
  }
}

export class DisplayNameTooLongException extends DomainException {
  readonly code = 'DISPLAY_NAME_TOO_LONG';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor(readonly maxLength: number) {
    super(`Display name must be at most ${maxLength} characters.`);
  }
}

// --- Google ------------------------------------------------------------------

export class GoogleTokenInvalidException extends DomainException {
  readonly code = 'GOOGLE_TOKEN_INVALID';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;
  constructor() {
    super('The Google sign-in token is invalid or expired.');
  }
}

export class GoogleAccountAlreadyLinkedException extends DomainException {
  readonly code = 'GOOGLE_ACCOUNT_ALREADY_LINKED';
  readonly httpStatus = HttpStatus.CONFLICT;
  constructor() {
    super('This Google account is already linked to another user.');
  }
}

export class GoogleAccountNotLinkedException extends DomainException {
  readonly code = 'GOOGLE_ACCOUNT_NOT_LINKED';
  readonly httpStatus = HttpStatus.NOT_FOUND;
  constructor() {
    super('No account is linked to this Google identity. Sign in with your phone number first.');
  }
}

// --- Tokens / session ----------------------------------------------------

export class RefreshTokenInvalidException extends DomainException {
  readonly code = 'REFRESH_TOKEN_INVALID';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;
  constructor() {
    super('This refresh token is invalid.');
  }
}

export class RefreshTokenExpiredException extends DomainException {
  readonly code = 'REFRESH_TOKEN_EXPIRED';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;
  constructor() {
    super('This session has expired. Please sign in again.');
  }
}

export class RefreshTokenReusedException extends DomainException {
  readonly code = 'REFRESH_TOKEN_REUSED';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;
  constructor() {
    super('This session was revoked for your security. Please sign in again.');
  }
}

export class TenantRequiredException extends DomainException {
  readonly code = 'TENANT_REQUIRED';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('This request requires a tenant context (X-Tenant-Slug header).');
  }
}

export class TenantMismatchException extends DomainException {
  readonly code = 'TENANT_MISMATCH';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;
  constructor() {
    super('This session token was issued for a different tenant.');
  }
}

export class UnauthenticatedException extends DomainException {
  readonly code = 'UNAUTHENTICATED';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;
  constructor() {
    super('Authentication is required for this request.');
  }
}

export class InvalidPhoneException extends DomainException {
  readonly code = 'INVALID_PHONE';
  readonly httpStatus = HttpStatus.BAD_REQUEST;
  constructor() {
    super('Enter a valid Bangladeshi mobile number.');
  }
}
