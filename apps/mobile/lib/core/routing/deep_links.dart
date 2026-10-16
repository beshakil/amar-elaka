import 'route_paths.dart';

/// The app screen for a notification's deep link (the API's `deepLink`, the
/// same in the inbox and in a push — ADR 059/060), or null when the app has
/// no screen for it (the notification then only marks itself read).
///
/// ```text
///   /chat, /chat/<id>                  the chat inbox, a conversation
///   /posts/<id>[?action=repost]        a post (the repost action included)
///   /saved-searches[/<id>], /saved     saved searches and their new results, saved items
///   /places/<id>                       a place
///   /stores/<id>/review                the review form (a review prompt)
///   /verification                      the member's own verification (ADR 062)
///   /account/bans                      the ban notice and appeals (ADR 063)
///   /complaints                        the member's complaints
///   /stores/<id>/verification          a store's business verification
///   /stores/me, /stores/<id>/imports/… "আমার দোকান" (the import report is on the web panel)
///   /info/blood/requests/<id>          an urgent blood request (ADR 064)
///   /info/blood/me/contacts            who contacted me, as a donor
///   /info/notices/<id>                 a notice's moderation decision (ADR 065)
///   /info/lost-found/<id>              a lost & found decision or contact
/// ```
String? appRouteForDeepLink(String? link) {
  if (link == null || link.isEmpty) return null;
  final uri = Uri.tryParse(link);
  if (uri == null) return null;
  final segments = uri.pathSegments;
  if (segments.isEmpty) return null;
  switch (segments.first) {
    case 'chat':
      return segments.length >= 2
          ? RoutePaths.conversationFor(segments[1])
          : RoutePaths.chat;
    case 'posts' when segments.length >= 2:
      return uri.hasQuery
          ? '${RoutePaths.postDetailFor(segments[1])}?${uri.query}'
          : RoutePaths.postDetailFor(segments[1]);
    case 'saved-searches':
      return segments.length >= 2
          ? RoutePaths.savedSearchFor(segments[1])
          : RoutePaths.savedSearches;
    case 'saved':
      return RoutePaths.saved;
    case 'places' when segments.length >= 2:
      return RoutePaths.placeFor(segments[1]);
    // "How was it?" (ADR 061): the review form for that store.
    case 'stores' when segments.length == 3 && segments[2] == 'review':
      return RoutePaths.writeReviewFor(segments[1]);
    // Verification decisions, expiry and renewal reminders (ADR 062).
    case 'stores' when segments.length == 3 && segments[2] == 'verification':
      return RoutePaths.storeVerificationFor(segments[1]);
    case 'stores':
      return RoutePaths.myStore;
    case 'verification':
      return RoutePaths.verification;
    case 'account' when segments.length >= 2 && segments[1] == 'bans':
      return RoutePaths.banNotice;
    case 'complaints':
      return RoutePaths.myComplaints;
    case 'info'
        when segments.length == 4 &&
            segments[1] == 'blood' &&
            segments[2] == 'requests':
      return RoutePaths.bloodRequestFor(segments[3]);
    case 'info'
        when segments.length == 4 &&
            segments[1] == 'blood' &&
            segments[3] == 'contacts':
      return RoutePaths.bloodContacts;
    case 'info' when segments.length == 3 && segments[1] == 'notices':
      return RoutePaths.noticeFor(segments[2]);
    case 'info' when segments.length == 3 && segments[1] == 'lost-found':
      return RoutePaths.lostFoundFor(segments[2]);
    default:
      return null;
  }
}
