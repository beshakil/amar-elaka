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

  static const String designSystem = '/design-system';
  static const String formPreview = '/form-preview';
}
