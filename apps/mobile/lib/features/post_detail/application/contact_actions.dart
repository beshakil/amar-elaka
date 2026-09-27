import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/platform/external_apps.dart';
import '../data/engagement_api.dart';

/// What happened when the buyer tapped Call or WhatsApp.
sealed class ContactOutcome {
  const ContactOutcome();
}

/// The dialer / WhatsApp / SMS app opened.
final class ContactOpened extends ContactOutcome {
  const ContactOpened();
}

/// The number was revealed, but WhatsApp isn't on this phone: offer the
/// browser (wa.me), an SMS or copying the number.
final class WhatsAppMissing extends ContactOutcome {
  const WhatsAppMissing(this.reveal);

  final ContactReveal reveal;
}

/// The number was revealed but nothing could open it: show it.
final class ContactNotOpened extends ContactOutcome {
  const ContactNotOpened(this.phone);

  final String phone;
}

/// The server refused or the network failed: [error] says why.
final class ContactFailed extends ContactOutcome {
  const ContactFailed(this.error);

  final AppException error;
}

/// Call / WhatsApp / SMS (ADR 036): every reveal goes through
/// POST /posts/:id/contact first — that's the lead — and only then opens
/// the dialer or WhatsApp with the number it returned.
class ContactActions {
  const ContactActions(this._api, this._apps);

  final EngagementApi _api;
  final ExternalApps _apps;

  Future<ContactOutcome> call(String postId) =>
      _reveal(postId, 'call', (reveal) async {
        final opened = await _apps.open(Uri.parse(reveal.href));
        return opened ? const ContactOpened() : ContactNotOpened(reveal.phone);
      });

  Future<ContactOutcome> sms(String postId) =>
      _reveal(postId, 'sms', (reveal) async {
        final opened = await _apps.open(Uri.parse(reveal.href));
        return opened ? const ContactOpened() : ContactNotOpened(reveal.phone);
      });

  /// The WhatsApp app itself (whatsapp://send), so the chat opens with the
  /// message typed; if it isn't installed, the caller offers alternatives.
  Future<ContactOutcome> whatsapp(String postId) =>
      _reveal(postId, 'whatsapp', (reveal) async {
        final app = whatsappAppUri(reveal);
        if (await _apps.canOpen(app) && await _apps.open(app)) {
          return const ContactOpened();
        }
        return WhatsAppMissing(reveal);
      });

  /// wa.me in the browser: WhatsApp Web, or its "get the app" page.
  Future<bool> openWhatsappWeb(ContactReveal reveal) =>
      _apps.open(Uri.parse(reveal.href));

  Future<ContactOutcome> _reveal(
    String postId,
    String channel,
    Future<ContactOutcome> Function(ContactReveal reveal) open,
  ) async {
    try {
      return await open(await _api.contact(postId, channel));
    } on AppException catch (error) {
      return ContactFailed(error);
    }
  }

  static Uri whatsappAppUri(ContactReveal reveal) => Uri(
    scheme: 'whatsapp',
    host: 'send',
    queryParameters: {
      'phone': reveal.phone.replaceFirst('+', ''),
      'text': ?reveal.message,
    },
  );
}

final contactActionsProvider = Provider<ContactActions>(
  (ref) => ContactActions(
    ref.watch(engagementApiProvider),
    ref.watch(externalAppsProvider),
  ),
);
