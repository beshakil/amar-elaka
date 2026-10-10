/**
 * The settings group a notification type is shown under (key under
 * `notifications.types`): related types share one line, as in the app
 * (apps/mobile/lib/features/notifications/presentation/notification_preferences_screen.dart).
 */
export function notificationTypeGroup(type: string): string {
  switch (type) {
    case 'new_message':
    case 'post_expiring':
    case 'saved_search_match':
    case 'saved_search_paused':
    case 'saved_search_weekly_digest':
    case 'saved_post_price_drop':
    case 'store_staff_invited':
    case 'store_import_finished':
      return type;
    case 'post_approved':
    case 'post_rejected':
    case 'post_removed':
      return 'post_outcome';
    case 'place_approved':
    case 'place_rejected':
      return 'place';
    case 'place_claim_approved':
    case 'place_claim_rejected':
      return 'claim';
    case 'place_edit_approved':
    case 'place_edit_rejected':
      return 'place_edit';
    case 'store_suspended':
    case 'store_reinstated':
      return 'store_status';
    case 'ban_issued':
    case 'appeal_decided':
      return 'account';
    default:
      return 'other';
  }
}
