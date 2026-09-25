import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/app_text_field.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/network/auth_error_messages.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/auth_controller.dart';
import '../domain/bd_phone.dart';
import 'bd_phone_formatter.dart';
import 'otp_verify_screen.dart';

/// Primary entry point for new and returning users: phone number → OTP.
/// `POST /auth/email/register` needs an existing session (it links a
/// password to an already-authenticated account), so there's no
/// email/password *signup* screen — only [EmailLoginScreen] for people who
/// already have one, and "Continue with Google" only signs in an
/// *already-linked* Google account (it can never create one — see ADR 020).
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _phoneController = TextEditingController();
  bool _isSubmitting = false;
  bool _isGoogleSubmitting = false;
  String? _errorText;

  bool get _phoneIsValid => isValidBdPhone(_phoneController.text);

  @override
  void dispose() {
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_phoneIsValid) return;
    final phone = normalizeBdPhone(_phoneController.text)!;

    setState(() {
      _isSubmitting = true;
      _errorText = null;
    });
    try {
      final resendAfter = await ref
          .read(authControllerProvider.notifier)
          .requestOtp(phone);
      if (mounted) {
        context.push(
          RoutePaths.otpVerify,
          extra: OtpVerifyArgs(phone: phone, resendAfter: resendAfter),
        );
      }
    } on AppException catch (e) {
      setState(
        () => _errorText = describeAuthError(e, AppLocalizations.of(context)!),
      );
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  Future<void> _continueWithGoogle() async {
    setState(() {
      _isGoogleSubmitting = true;
      _errorText = null;
    });
    try {
      // On GoogleSignedIn, AuthController's state flips to authenticated
      // and the router's redirect logic takes over. Null (cancelled) needs
      // nothing here; GoogleLinked can't happen while unauthenticated.
      await ref.read(authControllerProvider.notifier).googleSignIn(link: false);
    } on AppException catch (e) {
      if (mounted) {
        setState(
          () =>
              _errorText = describeAuthError(e, AppLocalizations.of(context)!),
        );
      }
    } finally {
      if (mounted) setState(() => _isGoogleSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      // Reachable both as the redirect target for a guest (nothing to pop)
      // and via an explicit push from a gated action (`requireLogin`) or
      // `ProfileScreen`'s guest CTA — `AppBar`'s default already only shows
      // a back button when there's actually somewhere to go back to.
      appBar: AppBar(),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                l10n.appTitle,
                style: Theme.of(context).textTheme.displayMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.xl),
              Text(
                l10n.loginTitle,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: AppSpacing.md),
              AppTextField(
                label: l10n.loginPhoneLabel,
                hint: l10n.loginPhoneHint,
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                prefixIcon: Icons.phone_outlined,
                errorText: _errorText,
                textInputAction: TextInputAction.done,
                onChanged: (_) => setState(() {}),
                inputFormatters: [BdPhoneFormatter()],
              ),
              const SizedBox(height: AppSpacing.md),
              AppButton(
                label: l10n.loginContinueButton,
                onPressed: _phoneIsValid ? _submit : null,
                isLoading: _isSubmitting,
              ),
              const SizedBox(height: AppSpacing.lg),
              AppButton(
                label: l10n.loginGoogleButton,
                icon: Icons.g_mobiledata,
                variant: AppButtonVariant.secondary,
                isLoading: _isGoogleSubmitting,
                onPressed: _continueWithGoogle,
              ),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                label: l10n.loginWithEmailLink,
                variant: AppButtonVariant.text,
                onPressed: () => context.push(RoutePaths.emailLogin),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
