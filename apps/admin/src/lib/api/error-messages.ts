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
    // Local information services (ADR 064).
    case 'INFO_STAFF_ONLY':
      return 'permissionDenied';
    case 'BAZAR_ENTRY_REFUSED':
      return 'bazarEntryRefused';
    case 'BLOOD_REQUEST_REFUSED':
    case 'BLOOD_REQUEST_NOT_FOUND':
      return 'bloodRequestRefused';
    case 'EMERGENCY_CONTACT_NOT_FOUND':
      return 'emergencyContactNotFound';
    // Field agent mode (ADR 066).
    case 'AGENT_NOT_ACTIVE':
      return 'agentNotActive';
    case 'AGENT_ADMIN_ONLY':
      return 'agentAdminOnly';
    case 'AGENT_NOT_FOUND':
      return 'agentNotFound';
    case 'AGENT_ALREADY_EXISTS':
      return 'agentAlreadyExists';
    case 'AGENT_TASK_NOT_FOUND':
      return 'agentTaskNotFound';
    // The info engine (ADR 065).
    case 'OUTAGE_REFUSED':
      return 'outageRefused';
    case 'NOTICE_REFUSED':
      return 'noticeRefused';
    case 'LOST_FOUND_REFUSED':
      return 'lostFoundRefused';
    case 'GOV_SERVICE_REFUSED':
      return 'govServiceRefused';
    case 'INFO_DECISION_REFUSED':
      return 'infoDecisionRefused';
    case 'INFO_ITEM_NOT_FOUND':
      return 'infoItemNotFound';
    case 'INFO_SERVICE_DISABLED':
      return 'infoServiceDisabled';
    case 'INFO_AREA_REQUIRED':
      return 'tenantRequired';
    case 'VERIFICATION_NOT_FOUND':
      return 'verificationNotFound';
    case 'VERIFICATION_DECISION_INVALID':
      return 'verificationDecisionInvalid';
    case 'BAN_NOT_ALLOWED':
      return 'banNotAllowed';
    case 'BAN_NOT_FOUND':
      return 'banNotFound';
    case 'APPEAL_NOT_ALLOWED':
      return 'appealNotAllowed';
    case 'APPEAL_DECISION_INVALID':
      return 'appealDecisionInvalid';
    case 'BLACKLIST_NOT_ALLOWED':
      return 'blacklistNotAllowed';
    case 'COMPLAINT_UPDATE_INVALID':
      return 'complaintUpdateInvalid';
    case 'BAN_ACTION_FORBIDDEN':
      return 'banActionForbidden';
    case 'ROLE_ALREADY_EXISTS':
      return 'roleAlreadyExists';
    case 'ROLE_BUILTIN_IMMUTABLE':
      return 'roleBuiltinImmutable';
    case 'ROLE_NOT_FOUND':
      return 'roleNotFound';
    case 'MODERATION_POST_NOT_FOUND':
      return 'moderationPostNotFound';
    case 'POST_ILLEGAL_TRANSITION':
      return 'moderationIllegalTransition';
    case 'LEGAL_HOLD_BLOCKS_SCRUB':
      return 'legalHoldBlocksScrub';
    case 'MODERATION_BULK_TOO_LARGE':
      return 'moderationBulkTooLarge';
    case 'VALIDATION_FAILED':
      return 'validationFailed';
    case 'PLACE_NOT_FOUND':
    case 'PLACE_SUGGESTION_NOT_FOUND':
    case 'CLAIM_NOT_FOUND':
    case 'DUPLICATE_CANDIDATE_NOT_FOUND':
      return 'placeItemGone';
    case 'PLACE_NOT_PENDING':
    case 'PLACE_SUGGESTION_NOT_PENDING':
    case 'CLAIM_NOT_PENDING':
    case 'PLACE_NO_OPEN_REPORTS':
      return 'placeAlreadyDecided';
    case 'PLACE_STATUS_LOCKED':
      return 'placeStatusLocked';
    case 'PLACE_LOCATION_OTHER_TENANT':
      return 'placeLocationOtherTenant';
    default:
      return error.status >= 500 ? 'server' : 'unexpected';
  }
}
