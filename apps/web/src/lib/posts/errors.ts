import { localizeDigits } from '@amar-elaka/dynamic-form';
import { text } from '../text';

/** A failure as the post screens got it: the API code (or ours) and its details. */
export interface PostError {
  code: string;
  details?: unknown;
  status?: number;
}

/**
 * The `postErrors` message key (and values) for a failure — every code the
 * post endpoints return gets its own specific Bengali sentence, never
 * "something went wrong" and never the API's English text (the same wording
 * as the app's post_error_messages.dart). An unknown code names itself.
 */
export function postErrorMessage(
  error: PostError,
  formatDate: (iso: string) => string,
): { key: string; values?: Record<string, string> } {
  const details =
    typeof error.details === 'object' && error.details !== null
      ? (error.details as Record<string, unknown>)
      : {};
  const number = (value: unknown) => localizeDigits(text(value), 'bn');
  switch (error.code) {
    case 'NETWORK':
    case 'API_UNREACHABLE':
      return { key: 'network' };
    case 'POST_LIMIT_REACHED':
      return {
        key: details.limit === 'daily' ? 'limitDaily' : 'limitActive',
        values: { max: number(details.max) },
      };
    case 'POST_TEXT_TOO_LONG':
      return {
        key: details.field === 'description' ? 'descriptionTooLong' : 'titleTooLong',
        values: { max: number(details.max) },
      };
    case 'FIELD_VALIDATION_FAILED':
      return { key: 'fields' };
    case 'POST_MEDIA_INVALID':
    case 'UPLOAD_MISSING':
    case 'UPLOAD_REJECTED':
      return { key: 'mediaInvalid' };
    case 'POST_MEDIA_TENANT_MISMATCH':
      return { key: 'mediaTenantMismatch' };
    case 'POST_TOO_MANY_MEDIA':
      return { key: 'tooManyMedia' };
    case 'UPLOAD_RATE_LIMITED':
      return { key: 'uploadRateLimited' };
    case 'PROCESSING_TIMEOUT':
      return { key: 'processingTimeout' };
    case 'CATEGORY_NOT_POSTABLE':
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_HAS_NO_FIELD_SCHEMA':
      return { key: 'categoryNotPostable' };
    case 'POST_NOT_EDITABLE':
      return { key: 'notEditable' };
    case 'POST_ILLEGAL_TRANSITION':
      return { key: 'illegalTransition' };
    case 'POST_NOT_FOUND':
      return { key: 'notFound' };
    case 'POST_NOT_OWNER':
      return { key: 'notOwner' };
    case 'POST_RENEW_TOO_EARLY':
      return {
        key: 'renewTooEarly',
        values: {
          date: typeof details.renewableFrom === 'string' ? formatDate(details.renewableFrom) : '',
        },
      };
    case 'IDEMPOTENCY_KEY_REUSED':
      return { key: 'idempotencyReused' };
    case 'IDEMPOTENT_REQUEST_IN_PROGRESS':
      return { key: 'inProgress' };
    case 'LOCATION_NOT_FOUND':
      return { key: 'locationNotFound' };
    case 'UNAUTHENTICATED':
    case 'REFRESH_TOKEN_EXPIRED':
    case 'REFRESH_TOKEN_INVALID':
    case 'REFRESH_TOKEN_REUSED':
      return { key: 'signIn' };
    case 'ACCOUNT_RESTRICTED':
    case 'ACCOUNT_BANNED':
    case 'ACCOUNT_TERMINATED':
      return { key: 'accountRestricted' };
    case 'PERMISSION_DENIED':
    case 'OWNERSHIP_REQUIRED':
      return { key: 'permission' };
    case 'TENANT_REQUIRED':
    case 'TENANT_NOT_FOUND':
    case 'TENANT_MISMATCH':
    case 'TENANT_SUSPENDED':
    case 'TENANT_TERMINATED':
      return { key: 'tenant' };
    case 'VALIDATION_FAILED': {
      const paths = Array.isArray(error.details)
        ? error.details.map((issue) => text((issue as { path?: unknown }).path).split('.')[0])
        : [];
      return paths.includes('contactPhone')
        ? { key: 'contactPhone' }
        : { key: 'validation', values: { fields: paths.join(', ') } };
    }
  }
  return (error.status ?? 0) >= 500
    ? { key: 'server', values: { code: error.code } }
    : { key: 'unknown', values: { code: error.code } };
}

/** The moderator's reason code in words (`moderationReasons` keys). */
export function moderationReasonKey(code: string | null | undefined): string {
  switch (code) {
    case 'spam':
    case 'wrong_category':
    case 'duplicate':
    case 'policy_violation':
    case 'prohibited_item':
    case 'scam_suspected':
    case 'poor_quality_listing':
    case 'contact_info_exposed':
    case 'illegal_content':
    case 'doxxing':
    case 'credible_threat':
      return code;
    case 'csam':
      return 'illegal_content';
    default:
      return 'other';
  }
}
