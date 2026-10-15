import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/app_text_field.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/account_gate.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/network/auth_error_messages.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/bd_phone.dart';
import '../../auth/presentation/bd_phone_formatter.dart';
import '../application/ban_providers.dart';
import '../data/ban_api.dart';
import '../data/ban_models.dart';

/// The ban notice (ADR 063, schema.md §9.10): why, how long, which area (its
/// name, never a person), the reference, and the appeal. A banned session
/// sees nothing else; a restricted one reaches it from the profile.
class BanNoticeScreen extends ConsumerWidget {
  const BanNoticeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final notices = ref.watch(banNoticesProvider);
    final banned = ref.watch(accountGateProvider) == AccountGate.banned;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.banNoticeTitle),
        automaticallyImplyLeading: !banned,
      ),
      body: switch (notices) {
        AsyncData(:final value) => ListView(
          key: const ValueKey('ban-notices'),
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            if (value.isEmpty) ...[
              Text(l10n.banNoneLeft),
              const SizedBox(height: AppSpacing.md),
              if (banned)
                AppButton(
                  key: const ValueKey('ban-continue'),
                  label: l10n.banContinue,
                  onPressed: () {
                    ref
                        .read(accountGateProvider.notifier)
                        .set(AccountGate.open);
                    context.go(RoutePaths.home);
                  },
                ),
            ] else ...[
              Text(l10n.banIntro),
              const SizedBox(height: AppSpacing.md),
              for (final n in value) BanNoticeCard(notice: n),
              const SizedBox(height: AppSpacing.sm),
              TextButton(
                key: const ValueKey('ban-refresh'),
                onPressed: () => ref.invalidate(banNoticesProvider),
                child: Text(l10n.banCheckAgain),
              ),
            ],
            if (banned) ...[
              const SizedBox(height: AppSpacing.lg),
              TextButton(
                key: const ValueKey('ban-logout'),
                onPressed: () => unawaited(
                  ref.read(authControllerProvider.notifier).logout(),
                ),
                child: Text(l10n.banLogout),
              ),
            ],
          ],
        ),
        AsyncError() => Center(
          child: TextButton(
            onPressed: () => ref.invalidate(banNoticesProvider),
            child: Text(l10n.banLoadFailed),
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

/// One ban: severity, why, how long, which area, the reference (copyable)
/// and where its appeal stands — or the button to make one.
class BanNoticeCard extends StatelessWidget {
  const BanNoticeCard({
    required this.notice,
    this.onAppeal,
    this.inApp = true,
    super.key,
  });

  final BanNotice notice;

  /// Overrides the in-app appeal route (the public path appeals in place).
  final VoidCallback? onAppeal;

  /// False on the public path: no session, so no in-app appeal route either.
  final bool inApp;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    String date(DateTime d) =>
        localizeDigits(DateFormat.yMMMMd(locale).format(d.toLocal()), locale);
    final area = notice.areaName(locale);
    return Card(
      key: ValueKey('ban-${notice.reference}'),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              banSeverityLabel(l10n, notice.severity),
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(banSeverityExplain(l10n, notice.severity)),
            const SizedBox(height: AppSpacing.sm),
            _Row(
              label: l10n.banWhy,
              value: banReasonLabel(l10n, notice.reasonCode),
            ),
            _Row(
              label: l10n.banHowLong,
              value: notice.permanent || notice.expiresAt == null
                  ? l10n.banPermanent
                  : l10n.banUntil(date(notice.expiresAt!)),
            ),
            _Row(
              label: l10n.banWhere,
              value: notice.platform || area == null
                  ? l10n.banEverywhere
                  : l10n.banInArea(area),
            ),
            Row(
              children: [
                Expanded(
                  child: _Row(
                    label: l10n.banReference,
                    value: notice.reference,
                  ),
                ),
                IconButton(
                  tooltip: l10n.banCopyReference,
                  icon: const Icon(Icons.copy, size: 18),
                  onPressed: () => unawaited(
                    Clipboard.setData(ClipboardData(text: notice.reference)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            if (notice.appealStatus case final status?)
              Text(
                appealStatusLabel(l10n, status, notice.appealReference ?? ''),
                key: const ValueKey('ban-appeal-status'),
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              )
            else if (notice.canAppeal && (onAppeal != null || inApp))
              AppButton(
                key: ValueKey('ban-appeal-${notice.reference}'),
                label: l10n.banAppeal,
                variant: AppButtonVariant.secondary,
                onPressed:
                    onAppeal ??
                    () => context.push(RoutePaths.appealFor(notice.id)),
              ),
          ],
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.xs),
    child: Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '$label: ',
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          TextSpan(text: value),
        ],
      ),
    ),
  );
}

String banSeverityLabel(AppLocalizations l10n, BanSeverity s) => switch (s) {
  BanSeverity.restricted => l10n.banSeverityRestricted,
  BanSeverity.banned => l10n.banSeverityBanned,
  BanSeverity.terminated => l10n.banSeverityTerminated,
};

String banSeverityExplain(AppLocalizations l10n, BanSeverity s) => switch (s) {
  BanSeverity.restricted => l10n.banExplainRestricted,
  BanSeverity.banned => l10n.banExplainBanned,
  BanSeverity.terminated => l10n.banExplainTerminated,
};

/// Area ban reasons (ban_reasons) and blacklist reasons (blacklist_reasons).
String banReasonLabel(AppLocalizations l10n, String code) => switch (code) {
  'scam' || 'advance_payment_scam' => l10n.banReasonScam,
  'harassment' => l10n.banReasonHarassment,
  'spam' => l10n.banReasonSpam,
  'fake_listings' || 'fake_product' => l10n.banReasonFakeListings,
  'payment_fraud' => l10n.banReasonPaymentFraud,
  'identity_fraud' => l10n.banReasonIdentityFraud,
  'repeated_violations' => l10n.banReasonRepeated,
  _ => l10n.banReasonOther,
};

String appealStatusLabel(
  AppLocalizations l10n,
  AppealStatus s,
  String reference,
) => switch (s) {
  AppealStatus.waiting => l10n.appealWaiting(reference),
  AppealStatus.granted => l10n.appealGranted(reference),
  AppealStatus.reduced => l10n.appealReduced(reference),
  AppealStatus.upheld => l10n.appealUpheld(reference),
  AppealStatus.withdrawn => l10n.appealWithdrawn(reference),
};

String appealErrorMessage(AppLocalizations l10n, Object error) {
  if (error is! ApiException) return l10n.appealFailed;
  final details = error.body.details;
  final reason = details is Map ? details['reason'] : null;
  return switch (error.code) {
    'APPEAL_NOT_ALLOWED' => switch (reason) {
      'rate_limited' => l10n.appealRateLimited,
      'already_appealed' => l10n.appealAlready,
      'statement' => l10n.appealStatementInvalid,
      _ => l10n.appealNotAppealable,
    },
    'APPEAL_VERIFICATION_FAILED' => l10n.appealCodeExpired,
    final code when code.startsWith('OTP_') => describeAuthError(error, l10n),
    _ => l10n.appealFailed,
  };
}

/// The in-app appeal of one ban: the person's statement, sent once.
class AppealScreen extends ConsumerStatefulWidget {
  const AppealScreen({required this.targetId, super.key});

  final String targetId;

  @override
  ConsumerState<AppealScreen> createState() => _AppealScreenState();
}

class _AppealScreenState extends ConsumerState<AppealScreen> {
  final _statement = TextEditingController();
  bool _busy = false;
  String? _reference;

  @override
  void dispose() {
    _statement.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.appealTitle)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          if (_reference case final reference?) ...[
            Text(
              l10n.appealSent(reference),
              key: const ValueKey('appeal-sent'),
            ),
            const SizedBox(height: AppSpacing.md),
            AppButton(label: l10n.appealBack, onPressed: () => context.pop()),
          ] else ...[
            Text(l10n.appealIntro),
            const SizedBox(height: AppSpacing.md),
            TextField(
              key: const ValueKey('appeal-statement'),
              controller: _statement,
              minLines: 4,
              maxLines: 10,
              enabled: !_busy,
              decoration: InputDecoration(
                labelText: l10n.appealStatementLabel,
                hintText: l10n.appealStatementHint,
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: AppSpacing.md),
            AppButton(
              key: const ValueKey('appeal-submit'),
              label: l10n.appealSubmit,
              isLoading: _busy,
              onPressed: _statement.text.trim().isEmpty
                  ? null
                  : () => unawaited(_submit()),
            ),
          ],
        ],
      ),
    );
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      final reference = await ref
          .read(banApiProvider)
          .appeal(targetId: widget.targetId, statement: _statement.text.trim());
      ref.invalidate(banNoticesProvider);
      if (mounted) setState(() => _reference = reference);
    } on Object catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(appealErrorMessage(l10n, e))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

enum _Step { phone, code, choose, statement, done }

/// The public appeal path (§9.10) for a terminated person, or anyone who
/// can't sign in: phone → SMS code → their bans → statement → reference.
/// No session is ever made; the code proves the phone, nothing more.
class PublicAppealScreen extends ConsumerStatefulWidget {
  const PublicAppealScreen({super.key});

  @override
  ConsumerState<PublicAppealScreen> createState() => _PublicAppealScreenState();
}

class _PublicAppealScreenState extends ConsumerState<PublicAppealScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _statement = TextEditingController();
  _Step _step = _Step.phone;
  String? _normalized;
  PublicAppealStatus? _status;
  BanNotice? _chosen;
  String? _reference;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    _statement.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.publicAppealTitle),
        leading: IconButton(
          icon: const Icon(Icons.close),
          tooltip: l10n.publicAppealClose,
          onPressed: _close,
        ),
      ),
      body: ListView(
        key: const ValueKey('public-appeal'),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          ...switch (_step) {
            _Step.phone => [
              Text(l10n.publicAppealIntro),
              const SizedBox(height: AppSpacing.md),
              AppTextField(
                key: const ValueKey('public-appeal-phone'),
                label: l10n.loginPhoneLabel,
                hint: l10n.loginPhoneHint,
                controller: _phone,
                keyboardType: TextInputType.phone,
                prefixIcon: Icons.phone_outlined,
                inputFormatters: [BdPhoneFormatter()],
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppSpacing.md),
              AppButton(
                key: const ValueKey('public-appeal-send-code'),
                label: l10n.publicAppealSendCode,
                isLoading: _busy,
                onPressed: isValidBdPhone(_phone.text)
                    ? () => unawaited(_sendCode())
                    : null,
              ),
            ],
            _Step.code => [
              Text(l10n.publicAppealCodeSent),
              const SizedBox(height: AppSpacing.md),
              AppTextField(
                key: const ValueKey('public-appeal-code'),
                label: l10n.publicAppealCodeLabel,
                controller: _code,
                keyboardType: TextInputType.number,
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppSpacing.md),
              AppButton(
                key: const ValueKey('public-appeal-check'),
                label: l10n.publicAppealCheck,
                isLoading: _busy,
                onPressed: _code.text.trim().length >= 4
                    ? () => unawaited(_check())
                    : null,
              ),
            ],
            _Step.choose => [
              if (_status!.items.isEmpty)
                Text(
                  l10n.publicAppealNothing,
                  key: const ValueKey('public-appeal-nothing'),
                )
              else ...[
                Text(
                  _status!.appealsLeftToday > 0
                      ? l10n.publicAppealChoose
                      : l10n.appealRateLimited,
                ),
                const SizedBox(height: AppSpacing.md),
                for (final n in _status!.items)
                  BanNoticeCard(
                    notice: n,
                    inApp: false,
                    onAppeal: _status!.appealsLeftToday > 0
                        ? () => setState(() {
                            _chosen = n;
                            _step = _Step.statement;
                          })
                        : null,
                  ),
              ],
            ],
            _Step.statement => [
              Text(l10n.publicAppealFor(_chosen!.reference)),
              const SizedBox(height: AppSpacing.md),
              TextField(
                key: const ValueKey('public-appeal-statement'),
                controller: _statement,
                minLines: 4,
                maxLines: 10,
                decoration: InputDecoration(
                  labelText: l10n.appealStatementLabel,
                  hintText: l10n.appealStatementHint,
                  border: const OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppSpacing.md),
              AppButton(
                key: const ValueKey('public-appeal-submit'),
                label: l10n.appealSubmit,
                isLoading: _busy,
                onPressed: _statement.text.trim().isEmpty
                    ? null
                    : () => unawaited(_submit()),
              ),
            ],
            _Step.done => [
              Text(
                l10n.publicAppealDone(_reference ?? ''),
                key: const ValueKey('public-appeal-done'),
              ),
              const SizedBox(height: AppSpacing.md),
              AppButton(label: l10n.publicAppealClose, onPressed: _close),
            ],
          },
          if (_error case final error?) ...[
            const SizedBox(height: AppSpacing.md),
            Text(
              error,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
        ],
      ),
    );
  }

  void _close() {
    // The terminated gate held the app here; leaving clears it.
    ref.read(accountGateProvider.notifier).set(AccountGate.open);
    if (context.canPop()) {
      context.pop();
    } else {
      context.go(RoutePaths.home);
    }
  }

  Future<void> _guard(Future<void> Function() work) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await work();
    } on Object catch (e) {
      if (mounted) {
        setState(
          () => _error = appealErrorMessage(AppLocalizations.of(context)!, e),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendCode() => _guard(() async {
    _normalized = normalizeBdPhone(_phone.text);
    await ref.read(banApiProvider).requestAppealOtp(_normalized!);
    setState(() => _step = _Step.code);
  });

  Future<void> _check() => _guard(() async {
    final status = await ref
        .read(banApiProvider)
        .appealStatus(phone: _normalized!, otp: _code.text.trim());
    setState(() {
      _status = status;
      _step = _Step.choose;
    });
  });

  Future<void> _submit() => _guard(() async {
    final reference = await ref
        .read(banApiProvider)
        .publicAppeal(
          phone: _normalized!,
          appealToken: _status!.appealToken,
          reference: _chosen!.reference,
          statement: _statement.text.trim(),
        );
    setState(() {
      _reference = reference;
      _step = _Step.done;
    });
  });
}
