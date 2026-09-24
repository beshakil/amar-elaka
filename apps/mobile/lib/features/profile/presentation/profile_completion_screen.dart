import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/app_text_field.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/network/auth_error_messages.dart';
import '../../../core/network/media_upload_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';

/// Name + optional photo, reached right after every OTP verification
/// (pre-filled with whatever's already on the account, so a returning user
/// can just tap "not now") and later from `ProfileScreen`'s edit entry.
/// The optional "add email & password" section links credentials to the
/// current session — `POST /auth/email/register` can't create an account by
/// itself, so this is the only place that call happens.
class ProfileCompletionScreen extends ConsumerStatefulWidget {
  const ProfileCompletionScreen({super.key});

  @override
  ConsumerState<ProfileCompletionScreen> createState() =>
      _ProfileCompletionScreenState();
}

class _ProfileCompletionScreenState
    extends ConsumerState<ProfileCompletionScreen> {
  late final TextEditingController _nameController;
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  File? _pickedPhoto;
  bool _isSaving = false;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    final session = ref.read(authControllerProvider);
    final initialName = switch (session) {
      AuthSessionAuthenticated(:final me) => me.displayName,
      _ => '',
    };
    _nameController = TextEditingController(text: initialName);
  }

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _pickPhoto() async {
    final picked = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      imageQuality: 85,
      maxWidth: 1024,
    );
    if (picked != null) setState(() => _pickedPhoto = File(picked.path));
  }

  Future<void> _save() async {
    setState(() {
      _isSaving = true;
      _errorText = null;
    });
    try {
      String? avatarStorageKey;
      final photo = _pickedPhoto;
      if (photo != null) {
        avatarStorageKey = await ref
            .read(mediaUploadServiceProvider)
            .upload(photo, kind: MediaKind.image, contentType: 'image/jpeg');
      }

      final name = _nameController.text.trim();
      await ref
          .read(authControllerProvider.notifier)
          .updateProfile(
            displayName: name.isEmpty ? null : name,
            avatarStorageKey: avatarStorageKey,
          );

      final email = _emailController.text.trim();
      final password = _passwordController.text;
      if (email.isNotEmpty && password.isNotEmpty) {
        await ref
            .read(authControllerProvider.notifier)
            .registerEmailPassword(email: email, password: password);
      }

      if (mounted) context.pop();
    } on AppException catch (e) {
      if (mounted) {
        setState(
          () =>
              _errorText = describeAuthError(e, AppLocalizations.of(context)!),
        );
      }
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.profileCompletionTitle)),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: GestureDetector(
                  onTap: _pickPhoto,
                  child: CircleAvatar(
                    radius: 48,
                    backgroundImage: _pickedPhoto != null
                        ? FileImage(_pickedPhoto!)
                        : null,
                    child: _pickedPhoto == null
                        ? const Icon(Icons.add_a_photo_outlined, size: 32)
                        : null,
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              Center(
                child: AppButton(
                  label: _pickedPhoto == null
                      ? l10n.profileCompletionPhotoButton
                      : l10n.profileCompletionChangePhotoButton,
                  variant: AppButtonVariant.text,
                  onPressed: _pickPhoto,
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              AppTextField(
                label: l10n.profileCompletionNameLabel,
                controller: _nameController,
                errorText: _errorText,
                textInputAction: TextInputAction.next,
              ),
              const SizedBox(height: AppSpacing.xl),
              Text(
                l10n.profileCompletionEmailSectionTitle,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.xs),
              Text(
                l10n.profileCompletionEmailSectionNote,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              AppTextField(
                label: l10n.emailLabel,
                controller: _emailController,
                keyboardType: TextInputType.emailAddress,
                prefixIcon: Icons.mail_outline,
              ),
              const SizedBox(height: AppSpacing.sm),
              AppTextField(
                label: l10n.passwordLabel,
                controller: _passwordController,
                obscureText: true,
                prefixIcon: Icons.lock_outline,
              ),
              const SizedBox(height: AppSpacing.xl),
              AppButton(
                label: l10n.profileCompletionSaveButton,
                onPressed: _save,
                isLoading: _isSaving,
              ),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                label: l10n.profileCompletionSkipButton,
                variant: AppButtonVariant.text,
                onPressed: () => context.pop(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
