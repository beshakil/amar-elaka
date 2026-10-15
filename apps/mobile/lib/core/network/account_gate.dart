import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What the API said about the signed-in account (ADR 063, schema.md §9.10).
///  - open: nothing, or restricted (browse yes; posting, chat, reviews say why);
///  - banned: only the ban notice and the appeal — every other request is
///    refused, so the router keeps the person on the notice;
///  - terminated: no session at all — the public appeal path only.
enum AccountGate { open, banned, terminated }

/// Set by [AccountStateInterceptor] from a 403 ACCOUNT_BANNED /
/// ACCOUNT_TERMINATED; cleared when the notice finds no ban left, or on
/// sign-out. Lives in core (like SessionSignal) so the network layer can set
/// it without depending on a feature.
class AccountGateNotifier extends Notifier<AccountGate> {
  @override
  AccountGate build() => AccountGate.open;

  void set(AccountGate gate) => state = gate;
}

final accountGateProvider = NotifierProvider<AccountGateNotifier, AccountGate>(
  AccountGateNotifier.new,
);
