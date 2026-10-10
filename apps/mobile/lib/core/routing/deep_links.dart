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
///   /stores/me, /stores/<id>/imports/… "আমার দোকান" (the import report is on the web panel)
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
    case 'stores':
      return RoutePaths.myStore;
    default:
      return null;
  }
}
