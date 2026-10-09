import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/design/widgets/network_photo.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';
import '../../media_upload/data/media_upload_transport.dart';
import '../../store/application/store_image_uploader.dart';
import '../../store/data/store_api.dart';
import '../../store/data/store_models.dart';
import '../application/my_store_providers.dart';
import '../../auth/domain/bd_phone.dart';
import 'store_messages.dart';

/// The store's details (ADR 057): names, about, address, numbers, logo and
/// banner. Only what changed is sent (PATCH /stores/:id).
class EditStoreScreen extends ConsumerWidget {
  const EditStoreScreen({required this.storeId, super.key});

  final String storeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final store = ref.watch(managedStoreProvider(storeId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.myStoreEditProfile)),
      body: switch (store) {
        AsyncData(:final value) => _EditForm(store: value),
        AsyncError() => ErrorState(
          title: l10n.myStoreLoadFailed,
          retryLabel: l10n.storeRetry,
          onRetry: () => ref.invalidate(managedStoreProvider(storeId)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _EditForm extends ConsumerStatefulWidget {
  const _EditForm({required this.store});

  final ManagedStore store;

  @override
  ConsumerState<_EditForm> createState() => _EditFormState();
}

class _EditFormState extends ConsumerState<_EditForm> {
  late final _nameBn = TextEditingController(text: widget.store.name.bn);
  late final _nameEn = TextEditingController(text: widget.store.name.en);
  late final _description = TextEditingController(
    text: widget.store.description,
  );
  late final _address = TextEditingController(text: widget.store.addressText);
  late final _phone = TextEditingController(
    text: widget.store.phone == null
        ? null
        : displayBdPhone(widget.store.phone!, 'bn'),
  );
  late final _whatsapp = TextEditingController(
    text: widget.store.whatsapp == null
        ? null
        : displayBdPhone(widget.store.whatsapp!, 'bn'),
  );
  String? _logoId;
  String? _bannerId;
  String? _uploading;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [
      _nameBn,
      _nameEn,
      _description,
      _address,
      _phone,
      _whatsapp,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickPhoto(String which) async {
    final l10n = AppLocalizations.of(context)!;
    final file = await ImagePicker().pickImage(source: ImageSource.gallery);
    if (file == null || !mounted) return;
    setState(() => _uploading = which);
    try {
      final id = await ref.read(storeImageUploaderProvider).upload(file.path);
      if (mounted) {
        setState(() => which == 'logo' ? _logoId = id : _bannerId = id);
      }
    } on UploadFailure {
      if (mounted) setState(() => _error = l10n.storePhotoFailed);
    } finally {
      if (mounted) setState(() => _uploading = null);
    }
  }

  /// The fields that differ from what's saved; null = an invalid number.
  Map<String, dynamic>? _patch() {
    final store = widget.store;
    String? text(TextEditingController c) =>
        c.text.trim().isEmpty ? null : c.text.trim();
    String? phone(TextEditingController c) =>
        c.text.trim().isEmpty ? null : normalizeBdPhone(toLatinDigits(c.text));
    if (text(_phone) != null && phone(_phone) == null) return null;
    if (text(_whatsapp) != null && phone(_whatsapp) == null) return null;
    return {
      if (text(_nameBn) case final name? when name != store.name.bn)
        'nameBn': name,
      if (text(_nameEn) != store.name.en) 'nameEn': text(_nameEn),
      if (text(_description) != store.description)
        'description': text(_description),
      if (text(_address) != store.addressText) 'addressText': text(_address),
      if (phone(_phone) != store.phone) 'phone': phone(_phone),
      if (phone(_whatsapp) != store.whatsapp) 'whatsapp': phone(_whatsapp),
      'logoMediaId': ?_logoId,
      'bannerMediaId': ?_bannerId,
    };
  }

  Future<void> _save() async {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.of(context);
    if (_nameBn.text.trim().isEmpty) {
      setState(() => _error = l10n.storeNameRequired);
      return;
    }
    final patch = _patch();
    if (patch == null) {
      setState(() => _error = l10n.storePhoneInvalid);
      return;
    }
    if (patch.isEmpty) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref.read(storeApiProvider).update(widget.store.id, patch);
      ref
        ..invalidate(managedStoreProvider(widget.store.id))
        ..invalidate(myStoresProvider);
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(l10n.myStoreSaved)));
      Navigator.of(context).pop();
    } on AppException catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = storeErrorMessage(error, l10n, locale);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    Widget field(
      String key,
      TextEditingController c,
      String label, {
      int lines = 1,
      bool phone = false,
    }) => Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: TextField(
        key: ValueKey('store-edit-$key'),
        controller: c,
        maxLines: lines,
        keyboardType: phone ? TextInputType.phone : null,
        decoration: InputDecoration(labelText: label),
      ),
    );
    Widget photo(
      String which,
      String label,
      StoreImage? current,
      String? uploaded,
    ) => ListTile(
      contentPadding: EdgeInsets.zero,
      leading: SizedBox.square(
        dimension: 48,
        child: uploaded != null
            ? const Icon(Icons.check_circle)
            : current == null
            ? const Icon(Icons.image_outlined)
            : ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: NetworkPhoto(
                  url: current.url,
                  thumbhash: current.thumbhash,
                ),
              ),
      ),
      title: Text(label),
      subtitle: _uploading == which ? Text(l10n.storePhotoUploading) : null,
      trailing: TextButton(
        onPressed: _uploading != null
            ? null
            : () => unawaited(_pickPhoto(which)),
        child: Text(l10n.storePickPhoto),
      ),
    );

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        field('name-bn', _nameBn, l10n.storeFieldNameBn),
        field('name-en', _nameEn, l10n.storeFieldNameEn),
        field(
          'description',
          _description,
          l10n.storeFieldDescription,
          lines: 3,
        ),
        field('address', _address, l10n.storeFieldAddress),
        field('phone', _phone, l10n.storeFieldPhone, phone: true),
        field('whatsapp', _whatsapp, l10n.storeFieldWhatsapp, phone: true),
        photo('logo', l10n.storeFieldLogo, widget.store.logo, _logoId),
        photo('banner', l10n.storeFieldBanner, widget.store.banner, _bannerId),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.sm),
            child: Text(
              _error!,
              style: TextStyle(color: theme.colorScheme.error),
            ),
          ),
        const SizedBox(height: AppSpacing.md),
        AppButton(
          key: const ValueKey('store-edit-save'),
          label: l10n.hoursSave,
          isLoading: _saving,
          onPressed: _saving || _uploading != null
              ? null
              : () => unawaited(_save()),
        ),
      ],
    );
  }
}
