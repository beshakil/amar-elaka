import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

/// Leaving the app: the dialer, WhatsApp, the SMS app, a browser, the share
/// sheet. Behind an interface so tests can see what would have opened.
abstract interface class ExternalApps {
  /// Whether something on the phone handles [uri] (e.g. is WhatsApp installed).
  Future<bool> canOpen(Uri uri);

  /// Opens [uri] outside the app; false if nothing could.
  Future<bool> open(Uri uri);

  Future<void> share(String text);
}

class PlatformExternalApps implements ExternalApps {
  const PlatformExternalApps();

  @override
  Future<bool> canOpen(Uri uri) => canLaunchUrl(uri);

  @override
  Future<bool> open(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } on Object {
      return false;
    }
  }

  @override
  Future<void> share(String text) =>
      SharePlus.instance.share(ShareParams(text: text));
}

final externalAppsProvider = Provider<ExternalApps>(
  (ref) => const PlatformExternalApps(),
);
