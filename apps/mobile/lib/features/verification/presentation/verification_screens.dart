import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../../core/design/tokens/app_radii.dart';
import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/evidence_uploader.dart';
import '../application/verification_providers.dart';
import '../data/verification_api.dart';
import '../data/verification_models.dart';

/// The member's own verification (ADR 062): their badge, their latest
/// request, and — when a request can be made — the identity form: the NID
/// number (hashed by the API at once, never kept anywhere) and a selfie.
class VerificationScreen extends ConsumerWidget {
  const VerificationScreen({this.picker, super.key});

  final ImagePicker? picker;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final mine = ref.watch(myVerificationsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.verificationTitle)),
      body: switch (mine) {
        AsyncData(:final value) => ListView(
          key: const ValueKey('verification-list'),
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            VerificationLevelCard(level: value.level),
            const SizedBox(height: AppSpacing.md),
            if (value.items.isNotEmpty) ...[
              VerificationRequestCard(request: value.items.first),
              const SizedBox(height: AppSpacing.md),
            ],
            switch (value.request) {
              RequestState.ok => _IdentityForm(picker: picker),
              RequestState.openRequest => Text(l10n.verificationWaiting),
              RequestState.alreadyVerified => Text(
                l10n.verificationIdentityDone,
              ),
            },
          ],
        ),
        AsyncError() => _Retry(
          onRetry: () => ref.invalidate(myVerificationsProvider),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

/// A store's business verification, for its owner: the trade licence and a
/// photo of the shop front with the owner in it, checked by the area's
/// moderators. The owner's own identity comes first.
class StoreVerificationScreen extends ConsumerWidget {
  const StoreVerificationScreen({
    required this.storeId,
    this.picker,
    super.key,
  });

  final String storeId;
  final ImagePicker? picker;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final store = ref.watch(storeVerificationProvider(storeId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.storeVerificationTitle)),
      body: switch (store) {
        AsyncData(:final value) => ListView(
          key: const ValueKey('store-verification-list'),
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            VerificationLevelCard(level: value.level),
            const SizedBox(height: AppSpacing.md),
            if (value.items.isNotEmpty) ...[
              VerificationRequestCard(request: value.items.first),
              const SizedBox(height: AppSpacing.md),
            ],
            if (!value.ownerIdentityChecked) ...[
              Text(l10n.storeVerificationIdentityFirst),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                key: const ValueKey('store-verification-identity'),
                label: l10n.verificationTitle,
                variant: AppButtonVariant.secondary,
                onPressed: () => context.push(RoutePaths.verification),
              ),
            ] else
              switch (value.request) {
                RequestState.ok => _BusinessForm(
                  storeId: storeId,
                  picker: picker,
                ),
                RequestState.openRequest => Text(l10n.verificationWaiting),
                RequestState.alreadyVerified => Text(
                  l10n.storeVerificationDone,
                ),
              },
          ],
        ),
        AsyncError() => _Retry(
          onRetry: () => ref.invalidate(storeVerificationProvider(storeId)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

/// The badge someone (or a store) has now.
class VerificationLevelCard extends StatelessWidget {
  const VerificationLevelCard({required this.level, super.key});

  final VerificationLevel level;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final verified =
        level == VerificationLevel.identityChecked ||
        level == VerificationLevel.businessVerified;
    return Card(
      key: const ValueKey('verification-level'),
      child: ListTile(
        leading: Icon(
          verified ? Icons.verified : Icons.verified_outlined,
          color: verified ? theme.colorScheme.primary : null,
        ),
        title: Text(l10n.verificationLevelHeading),
        subtitle: Text(verificationLevelLabel(l10n, level)),
      ),
    );
  }
}

String verificationLevelLabel(AppLocalizations l10n, VerificationLevel l) =>
    switch (l) {
      VerificationLevel.none => l10n.verificationLevelNone,
      VerificationLevel.phoneVerified => l10n.verificationLevelPhone,
      VerificationLevel.identityChecked => l10n.verificationLevelIdentity,
      VerificationLevel.businessVerified => l10n.verificationLevelBusiness,
    };

/// The latest request: waiting, approved (until when), rejected (why) or
/// expired.
class VerificationRequestCard extends StatelessWidget {
  const VerificationRequestCard({required this.request, super.key});

  final VerificationRequest request;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    String date(DateTime d) =>
        localizeDigits(DateFormat.yMMMMd(locale).format(d.toLocal()), locale);
    final status = switch (request.status) {
      VerificationStatus.submitted ||
      VerificationStatus.inReview => l10n.verificationStatusWaiting,
      VerificationStatus.approved =>
        request.expiresAt == null
            ? l10n.verificationStatusApproved
            : l10n.verificationStatusApprovedUntil(date(request.expiresAt!)),
      VerificationStatus.rejected => l10n.verificationStatusRejected,
      VerificationStatus.expired => l10n.verificationStatusExpired,
      VerificationStatus.revoked => l10n.verificationStatusRevoked,
    };
    final rejected = request.status == VerificationStatus.rejected;
    return Card(
      key: const ValueKey('verification-request'),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              status,
              style: theme.textTheme.titleSmall?.copyWith(
                color: rejected ? theme.colorScheme.error : null,
              ),
            ),
            Text(
              l10n.verificationSubmittedOn(date(request.createdAt)),
              style: theme.textTheme.bodySmall,
            ),
            if (rejected && request.rejectionReason != null) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(rejectionReasonLabel(l10n, request.rejectionReason!)),
            ],
            if (request.note case final note? when note.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(note, style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }
}

String rejectionReasonLabel(AppLocalizations l10n, String code) =>
    switch (code) {
      'document_unclear' => l10n.verificationRejectUnclear,
      'document_expired' => l10n.verificationRejectExpired,
      'name_mismatch' => l10n.verificationRejectNameMismatch,
      'suspected_fraud' => l10n.verificationRejectFraud,
      'duplicate_submission' => l10n.verificationRejectDuplicate,
      _ => l10n.verificationRejectOther,
    };

/// The message for a refused submission.
String verificationErrorMessage(AppLocalizations l10n, Object error) {
  if (error is EvidenceRejected) return l10n.verificationPhotoFailed;
  if (error is! ApiException) return l10n.verificationFailed;
  final details = error.body.details;
  final reason = details is Map ? details['reason'] : null;
  return switch (error.code) {
    'VERIFICATION_NID_INVALID' => l10n.verificationNidInvalid,
    'VERIFICATION_EVIDENCE_INVALID' => l10n.verificationPhotoFailed,
    'VERIFICATION_NOT_ALLOWED' => switch (reason) {
      'phone_unverified' => l10n.verificationPhoneFirst,
      'identity_required' => l10n.storeVerificationIdentityFirst,
      'open_request' => l10n.verificationWaiting,
      'already_verified' => l10n.verificationIdentityDone,
      'store_inactive' => l10n.myStoreNotActive,
      _ => l10n.verificationFailed,
    },
    _ => l10n.verificationFailed,
  };
}

class _Retry extends StatelessWidget {
  const _Retry({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: TextButton(
      onPressed: onRetry,
      child: Text(AppLocalizations.of(context)!.verificationLoadFailed),
    ),
  );
}

/// One photo to provide: empty, or a thumbnail of the picked one.
class _PhotoSlot extends StatelessWidget {
  const _PhotoSlot({
    required this.slotKey,
    required this.label,
    required this.hint,
    required this.path,
    required this.onPick,
  });

  final String slotKey;
  final String label;
  final String hint;
  final String? path;
  final VoidCallback? onPick;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    return Card(
      key: ValueKey('verification-photo-$slotKey'),
      clipBehavior: Clip.antiAlias,
      child: ListTile(
        leading: ClipRRect(
          borderRadius: BorderRadius.circular(AppRadii.sm),
          child: SizedBox.square(
            dimension: AppSpacing.xxxl,
            child: path == null
                ? ColoredBox(
                    color: theme.colorScheme.surfaceContainerHighest,
                    child: const Icon(Icons.photo_camera_outlined),
                  )
                : Image.file(File(path!), fit: BoxFit.cover),
          ),
        ),
        title: Text(label),
        subtitle: Text(hint),
        trailing: TextButton(
          onPressed: onPick,
          child: Text(
            path == null
                ? l10n.verificationTakePhoto
                : l10n.verificationRetakePhoto,
          ),
        ),
      ),
    );
  }
}

class _IdentityForm extends ConsumerStatefulWidget {
  const _IdentityForm({this.picker});

  final ImagePicker? picker;

  @override
  ConsumerState<_IdentityForm> createState() => _IdentityFormState();
}

class _IdentityFormState extends ConsumerState<_IdentityForm> {
  final _nid = TextEditingController();
  String? _selfie;
  String? _nidError;
  bool _busy = false;

  @override
  void dispose() {
    _nid.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          l10n.verificationIdentityHeading,
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(l10n.verificationIdentityIntro),
        const SizedBox(height: AppSpacing.md),
        TextField(
          key: const ValueKey('verification-nid'),
          controller: _nid,
          enabled: !_busy,
          keyboardType: TextInputType.number,
          autocorrect: false,
          enableSuggestions: false,
          enableIMEPersonalizedLearning: false,
          autofillHints: const <String>[],
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9০-৯\s-]')),
          ],
          decoration: InputDecoration(
            labelText: l10n.verificationNidLabel,
            helperText: l10n.verificationNidHelper,
            errorText: _nidError,
            border: const OutlineInputBorder(),
          ),
          onChanged: (_) {
            if (_nidError != null) setState(() => _nidError = null);
          },
        ),
        const SizedBox(height: AppSpacing.sm),
        _PhotoSlot(
          slotKey: 'selfie',
          label: l10n.verificationSelfieLabel,
          hint: l10n.verificationSelfieHint,
          path: _selfie,
          onPick: _busy ? null : () => unawaited(_pick()),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(l10n.verificationPrivacyNote, style: theme.textTheme.bodySmall),
        const SizedBox(height: AppSpacing.md),
        AppButton(
          key: const ValueKey('verification-submit'),
          label: l10n.verificationSubmit,
          isLoading: _busy,
          onPressed: _selfie == null ? null : () => unawaited(_submit()),
        ),
      ],
    );
  }

  Future<void> _pick() async {
    final picked = await (widget.picker ?? ImagePicker()).pickImage(
      source: ImageSource.camera,
      preferredCameraDevice: CameraDevice.front,
    );
    if (picked == null || !mounted) return;
    setState(() => _selfie = picked.path);
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final nid = normalizeNid(_nid.text);
    if (nid == null) {
      setState(() => _nidError = l10n.verificationNidInvalid);
      return;
    }
    setState(() => _busy = true);
    try {
      final selfieId = await ref.read(evidenceUploaderProvider)(_selfie!);
      await ref
          .read(verificationApiProvider)
          .submitIdentity(nid: nid, selfieMediaId: selfieId);
      // The number leaves the phone once; nothing keeps it.
      _nid.clear();
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.verificationSubmitted)),
      );
      ref.invalidate(myVerificationsProvider);
    } on Object catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(verificationErrorMessage(l10n, e))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

class _BusinessForm extends ConsumerStatefulWidget {
  const _BusinessForm({required this.storeId, this.picker});

  final String storeId;
  final ImagePicker? picker;

  @override
  ConsumerState<_BusinessForm> createState() => _BusinessFormState();
}

class _BusinessFormState extends ConsumerState<_BusinessForm> {
  String? _licence;
  String? _front;
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(l10n.storeVerificationHeading, style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.xs),
        Text(l10n.storeVerificationIntro),
        const SizedBox(height: AppSpacing.md),
        _PhotoSlot(
          slotKey: 'licence',
          label: l10n.storeVerificationLicenceLabel,
          hint: l10n.storeVerificationLicenceHint,
          path: _licence,
          onPick: _busy
              ? null
              : () => unawaited(_pick((p) => _licence = p, gallery: true)),
        ),
        _PhotoSlot(
          slotKey: 'shop-front',
          label: l10n.storeVerificationFrontLabel,
          hint: l10n.storeVerificationFrontHint,
          path: _front,
          onPick: _busy ? null : () => unawaited(_pick((p) => _front = p)),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(
          l10n.storeVerificationPrivacyNote,
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
        AppButton(
          key: const ValueKey('store-verification-submit'),
          label: l10n.verificationSubmit,
          isLoading: _busy,
          onPressed: _licence == null || _front == null
              ? null
              : () => unawaited(_submit()),
        ),
      ],
    );
  }

  /// The licence may already be a photo in the gallery; the shop front is
  /// taken there and then.
  Future<void> _pick(
    void Function(String path) set, {
    bool gallery = false,
  }) async {
    final picker = widget.picker ?? ImagePicker();
    final source = gallery ? await _chooseSource() : ImageSource.camera;
    if (source == null) return;
    final picked = await picker.pickImage(source: source);
    if (picked == null || !mounted) return;
    setState(() => set(picked.path));
  }

  Future<ImageSource?> _chooseSource() {
    final l10n = AppLocalizations.of(context)!;
    return showModalBottomSheet<ImageSource>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: Text(l10n.verificationTakePhoto),
              onTap: () => Navigator.of(context).pop(ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: Text(l10n.verificationFromGallery),
              onTap: () => Navigator.of(context).pop(ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      final upload = ref.read(evidenceUploaderProvider);
      final licenceId = await upload(_licence!, storeId: widget.storeId);
      final frontId = await upload(_front!, storeId: widget.storeId);
      await ref
          .read(verificationApiProvider)
          .submitBusiness(
            widget.storeId,
            licenceMediaId: licenceId,
            shopFrontMediaId: frontId,
          );
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.verificationSubmitted)),
      );
      ref.invalidate(storeVerificationProvider(widget.storeId));
    } on Object catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(verificationErrorMessage(l10n, e))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
