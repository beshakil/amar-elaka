/// Every route path in the app, named — `go_router` calls use these, never
/// a string literal at the call site.
abstract final class RoutePaths {
  static const String splash = '/';
  static const String locationPermission = '/tenant-location-permission';
  static const String tenantConfirm = '/tenant-confirm';
  static const String tenantPicker = '/tenant-picker';
  static const String login = '/auth/login';
  static const String otpVerify = '/auth/otp-verify';
  static const String emailLogin = '/auth/email-login';
  static const String profileCompletion = '/profile/complete';

  static const String home = '/home';
  static const String map = '/map';
  static const String post = '/post';
  static const String info = '/info';
  static const String profile = '/profile';

  /// Post flows (full-screen, above the tab shell).
  static const String postEditor = '/post-editor';
  static String postEditorFor(String draftId) => '$postEditor/$draftId';
  static const String postResult = '/post-result';
  static const String myPosts = '/my-posts';

  /// A post's detail page (also the notifications' deep link, `/posts/<id>`).
  static const String postDetail = '/posts';
  static String postDetailFor(String postId) => '$postDetail/$postId';

  /// Search (full-screen, above the tab shell).
  static const String search = '/search';

  /// Saved searches, and one's new results (the alert notification's deep
  /// link, `/saved-searches/<id>`, ADR 041).
  static const String savedSearches = '/saved-searches';
  static String savedSearchFor(String id) => '$savedSearches/$id';

  /// Saved posts, places and stores (ADR 037).
  static const String saved = '/saved';

  /// The in-app notification inbox.
  static const String notifications = '/notifications';

  /// Notification settings per type and channel (ADR 059/060).
  static const String notificationPreferences = '/notifications/settings';

  /// The chat inbox, its archive, and one conversation (also the push's
  /// deep links, `/chat` and `/chat/<id>`, ADR 058/060).
  static const String chat = '/chat';
  static const String chatArchive = '/chat/archived';
  static String conversationFor(String conversationId) =>
      '$chat/$conversationId';

  /// Why we'd like to send notifications, before Android's own prompt (ADR 060).
  static const String pushRationale = '/push-rationale';

  /// A place's own screen.
  static const String place = '/places';
  static String placeFor(String placeId) => '$place/$placeId';

  /// "তথ্য সংশোধন" for a place (ADR 051).
  static const String placeSuggest = '/place-suggest';
  static String placeSuggestFor(String placeId) => '$placeSuggest/$placeId';

  /// A store's public page (ADR 054/057).
  static const String store = '/stores';
  static String storeFor(String slug) => '$store/$slug';

  /// "আমার দোকান" and its screens (ADR 057).
  static const String myStore = '/my-store';
  static const String myStoreCreate = '/my-store/new';
  static String myStoreEditFor(String storeId) => '$myStore/$storeId/edit';
  static String myStoreHoursFor(String storeId) => '$myStore/$storeId/hours';
  static String myStoreStaffFor(String storeId) => '$myStore/$storeId/staff';
  static String myStoreStockFor(String storeId) => '$myStore/$storeId/stock';
  static String sellerDashboardFor(String storeId) =>
      '$myStore/$storeId/dashboard';

  /// "এলাকার ম্যাপ ডাউনলোড" (ADR 050).
  static const String offlineMap = '/offline-map';

  static const String designSystem = '/design-system';
  static const String formPreview = '/form-preview';
  static const String mapDebug = '/map-debug';
}
