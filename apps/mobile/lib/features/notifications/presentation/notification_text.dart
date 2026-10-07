import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../data/notifications_api.dart';

/// A notification as the inbox words it: every type the API sends
/// (NotificationType in apps/api/src/notifications/notification-channel.ts),
/// from its params. An unknown type still shows, generically.
({String title, String? body}) notificationText(
  InboxItem item,
  AppLocalizations l10n,
  String locale,
) {
  final p = item.params;
  String? join(List<String?> parts) {
    final kept = parts.whereType<String>().where((s) => s.trim().isNotEmpty);
    return kept.isEmpty ? null : kept.join(' — ');
  }

  final reason = _reason(p['reasonCode'], p['reasonText'], l10n);
  return switch (item.type) {
    'post_approved' => (title: l10n.notePostApproved, body: p['postTitle']),
    'post_rejected' => (
      title: l10n.notePostRejected,
      body: join([p['postTitle'], reason]),
    ),
    'post_removed' => (
      title: l10n.notePostRemoved,
      body: join([p['postTitle'], reason]),
    ),
    'post_expiring' => (title: l10n.notePostExpiring, body: p['postTitle']),
    'saved_search_match' => (
      title: l10n.noteSavedSearchMatch(
        localizeDigits(p['count'] ?? '', locale),
      ),
      body: p['name'],
    ),
    'saved_search_paused' => (
      title: l10n.noteSavedSearchPaused,
      body: join([
        p['name'],
        if (p['idleDays'] case final days?)
          l10n.noteSavedSearchIdle(localizeDigits(days, locale)),
      ]),
    ),
    'geo_budget_warning' => (title: l10n.noteGeoBudgetWarning, body: null),
    'geo_budget_exhausted' => (title: l10n.noteGeoBudgetExhausted, body: null),
    'place_approved' => (title: l10n.notePlaceApproved, body: p['placeName']),
    'place_rejected' => (
      title: l10n.notePlaceRejected,
      body: join([p['placeName'], reason]),
    ),
    'place_claim_approved' => (
      title: l10n.notePlaceClaimApproved,
      body: p['placeName'],
    ),
    'place_claim_rejected' => (
      title: l10n.notePlaceClaimRejected,
      body: join([p['placeName'], reason]),
    ),
    'place_edit_approved' => (
      title: l10n.notePlaceEditApproved,
      body: p['placeName'],
    ),
    'place_edit_rejected' => (
      title: l10n.notePlaceEditRejected,
      body: join([p['placeName'], reason]),
    ),
    _ => (title: l10n.noteGeneric, body: null),
  };
}

/// A moderator's own words first; else the few codes a member should read.
String? _reason(String? code, String? text, AppLocalizations l10n) {
  if (text != null && text.trim().isNotEmpty) return text.trim();
  return switch (code) {
    'place_already_claimed' => l10n.noteReasonAlreadyClaimed,
    'suggestion_incorrect' => l10n.noteReasonSuggestionIncorrect,
    'duplicate' => l10n.noteReasonDuplicate,
    'spam' => l10n.noteReasonSpam,
    null => null,
    _ => l10n.noteReasonPolicy,
  };
}

/// Routes the app has for a notification's deep link; others only mark it read.
bool canOpenDeepLink(String? link) =>
    link != null &&
    (link.startsWith('${RoutePaths.postDetail}/') ||
        link.startsWith('${RoutePaths.savedSearches}/') ||
        link.startsWith('${RoutePaths.place}/'));
