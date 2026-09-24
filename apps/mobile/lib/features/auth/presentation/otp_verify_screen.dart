import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/otp_code_input.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/network/auth_error_messages.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/auth_controller.dart';

const _codeLength = 6;
// UI cosmetic (how long the resend button stays disabled) — not the
// backend's real `otp_resend_cooldown_seconds` platform setting, which the
// server enforces regardless of what this shows.
const _resendCooldown = Duration(seconds: 30);

class OtpVerifyScreen extends ConsumerStatefulWidget {
  const OtpVerifyScreen({required this.phone, super.key});

  final String phone;

  @override
  ConsumerState<OtpVerifyScreen> createState() => _OtpVerifyScreenState();
}

class _OtpVerifyScreenState extends ConsumerState<OtpVerifyScreen> {
  bool _isSubmitting = false;
  bool _isResending = false;
  String? _errorText;
  Timer? _resendTimer;
  int _resendSecondsLeft = _resendCooldown.inSeconds;

  @override
  void initState() {
    super.initState();
    _startResendTimer();
  }

  @override
  void dispose() {
    _resendTimer?.cancel();
    super.dispose();
  }

  void _startResendTimer() {
    setState(() => _resendSecondsLeft = _resendCooldown.inSeconds);
    _resendTimer?.cancel();
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_resendSecondsLeft <= 1) {
        timer.cancel();
        setState(() => _resendSecondsLeft = 0);
        return;
      }
      setState(() => _resendSecondsLeft -= 1);
    });
  }

  Future<void> _verify(String code) async {
    setState(() {
      _isSubmitting = true;
      _errorText = null;
    });
    try {
      await ref
          .read(authControllerProvider.notifier)
          .verifyOtp(phone: widget.phone, code: code);
      // Every fresh sign-in lands here so a returning user can confirm their
      // existing name/photo are still right — not signup-only. The screen
      // itself offers "not now" for anyone who doesn't need to change anything.
      if (mounted) context.push(RoutePaths.profileCompletion);
    } on AppException catch (e) {
      if (mounted) {
        setState(
          () =>
              _errorText = describeAuthError(e, AppLocalizations.of(context)!),
        );
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  Future<void> _resend() async {
    setState(() => _isResending = true);
    try {
      await ref.read(authControllerProvider.notifier).requestOtp(widget.phone);
      if (mounted) _startResendTimer();
    } on AppException catch (e) {
      if (mounted) {
        setState(
          () =>
              _errorText = describeAuthError(e, AppLocalizations.of(context)!),
        );
      }
    } finally {
      if (mounted) setState(() => _isResending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.otpVerifyTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                l10n.otpVerifyDescription(widget.phone),
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: AppSpacing.lg),
              OtpCodeInput(
                length: _codeLength,
                hasError: _errorText != null,
                onCompleted: _verify,
              ),
              if (_errorText != null) ...[
                const SizedBox(height: AppSpacing.sm),
                Text(
                  _errorText!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: AppSpacing.md),
              if (_isSubmitting)
                const Center(child: CircularProgressIndicator())
              else if (_resendSecondsLeft > 0)
                Text(
                  l10n.otpResendIn(_resendSecondsLeft),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium,
                )
              else
                AppButton(
                  label: l10n.otpResendButton,
                  variant: AppButtonVariant.text,
                  onPressed: _resend,
                  isLoading: _isResending,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
