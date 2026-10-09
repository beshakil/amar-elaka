import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart' show CatalogCategory;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/map/location_picker.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';
import '../../media_upload/data/media_upload_transport.dart';
import '../../post/data/posts_api.dart';
import '../../store/application/store_image_uploader.dart';
import '../../store/data/store_api.dart';
import '../../store/data/store_models.dart';
import '../application/my_store_providers.dart';
import '../../auth/domain/bd_phone.dart';
import 'store_messages.dart';

/// The kinds of store this area takes: its place categories (the API's own
/// rule for a store's category).
final storeCategoriesProvider =
    FutureProvider.autoDispose<List<CatalogCategory>>((ref) async {
      final all = await ref.watch(postsApiProvider).categories();
      return [
        for (final c in all)
          if (c.kind == 'place') c,
      ];
    });

/// Opening a store (ADR 057), one question per step: name → kind →
/// where (the shared map picker, ADR 046) → contact → logo and banner.
/// A likely duplicate nearby is shown and confirmed, as for places.
class CreateStoreScreen extends ConsumerStatefulWidget {
  const CreateStoreScreen({super.key, this.picker});

  /// Injectable for tests.
  final ImagePicker? picker;

  @override
  ConsumerState<CreateStoreScreen> createState() => _CreateStoreScreenState();
}

class _CreateStoreScreenState extends ConsumerState<CreateStoreScreen> {
  static const _steps = 5;

  int _step = 0;
  final _nameBn = TextEditingController();
  final _nameEn = TextEditingController();
  final _description = TextEditingController();
  final _address = TextEditingController();
  final _phone = TextEditingController();
  final _whatsapp = TextEditingController();
  String? _categoryId;
  GeoPoint? _location;
  String? _logoId;
  String? _bannerId;
  String? _uploading;
  bool _submitting = false;
  String? _error;

  AppLocalizations get _l10n => AppLocalizations.of(context)!;
  String get _locale => Localizations.localeOf(context).languageCode;

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

  /// The current step's problem, or null when it can move on.
  String? _check() => switch (_step) {
    0 when _nameBn.text.trim().isEmpty => _l10n.storeNameRequired,
    1 when _categoryId == null => _l10n.storeCategoryRequired,
    2 when _location == null => _l10n.storeLocationRequired,
    3
        when _phone.text.trim().isNotEmpty &&
                normalizeBdPhone(toLatinDigits(_phone.text)) == null ||
            _whatsapp.text.trim().isNotEmpty &&
                normalizeBdPhone(toLatinDigits(_whatsapp.text)) == null =>
      _l10n.storePhoneInvalid,
    _ => null,
  };

  void _next() {
    final problem = _check();
    setState(() => _error = problem);
    if (problem != null) return;
    if (_step < _steps - 1) {
      setState(() => _step++);
    } else {
      unawaited(_submit(confirmed: false));
    }
  }

  Future<void> _pickLocation() async {
    final picked = await Navigator.of(context).push<PickedLocation>(
      MaterialPageRoute(
        builder: (context) => Scaffold(
          appBar: AppBar(
            title: Text(AppLocalizations.of(context)!.storeWizardLocation),
          ),
          body: LocationPicker(
            purpose: 'store_setup',
            initial: _location,
            onChanged: (_) {},
            onConfirm: (location) => Navigator.of(context).pop(location),
          ),
        ),
      ),
    );
    if (picked == null || !mounted) return;
    setState(() {
      _location = picked.point;
      if (_address.text.trim().isEmpty && picked.label != null) {
        _address.text = picked.label!;
      }
      _error = null;
    });
  }

  Future<void> _pickPhoto(String which) async {
    final picker = widget.picker ?? ImagePicker();
    final file = await picker.pickImage(source: ImageSource.gallery);
    if (file == null || !mounted) return;
    setState(() => _uploading = which);
    try {
      final id = await ref.read(storeImageUploaderProvider).upload(file.path);
      if (!mounted) return;
      setState(() => which == 'logo' ? _logoId = id : _bannerId = id);
    } on UploadFailure {
      if (mounted) setState(() => _error = _l10n.storePhotoFailed);
    } finally {
      if (mounted) setState(() => _uploading = null);
    }
  }

  NewStore _newStore() {
    String? text(TextEditingController c) =>
        c.text.trim().isEmpty ? null : c.text.trim();
    return NewStore(
      nameBn: _nameBn.text.trim(),
      nameEn: text(_nameEn),
      description: text(_description),
      categoryId: _categoryId!,
      lat: _location!.lat,
      lng: _location!.lng,
      addressText: text(_address),
      phone: _phone.text.trim().isEmpty
          ? null
          : normalizeBdPhone(toLatinDigits(_phone.text)),
      whatsapp: _whatsapp.text.trim().isEmpty
          ? null
          : normalizeBdPhone(toLatinDigits(_whatsapp.text)),
      logoMediaId: _logoId,
      bannerMediaId: _bannerId,
    );
  }

  Future<void> _submit({required bool confirmed}) async {
    final messenger = ScaffoldMessenger.of(context);
    final l10n = _l10n;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final store = _newStore();
      final created = await ref
          .read(storeApiProvider)
          .create(confirmed ? store.confirmed() : store);
      ref.invalidate(myStoresProvider);
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            created.status == 'active'
                ? l10n.storeCreated
                : l10n.storeCreatedPending,
          ),
        ),
      );
      Navigator.of(context).pop(created.id);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      if (error.code == 'PLACE_LIKELY_DUPLICATE' && !confirmed) {
        if (await _confirmDuplicate(error)) await _submit(confirmed: true);
        return;
      }
      setState(() => _error = storeErrorMessage(error, l10n, _locale));
    } on AppException catch (error) {
      if (mounted) {
        setState(() {
          _submitting = false;
          _error = storeErrorMessage(error, l10n, _locale);
        });
      }
    }
  }

  /// The likely duplicates nearby, by name; true = "no, a new store".
  Future<bool> _confirmDuplicate(ApiException error) async {
    final names = switch (error.body.details) {
      {'candidates': final List<dynamic> list} => [
        for (final c in list)
          if (c case {'nameBn': final String name}) name,
      ],
      _ => const <String>[],
    };
    final answer = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(_l10n.storeDuplicateTitle),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_l10n.storeDuplicateBody),
            const SizedBox(height: AppSpacing.sm),
            for (final name in names) Text('• $name'),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(_l10n.commonCancel),
          ),
          FilledButton(
            key: const ValueKey('store-duplicate-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(_l10n.storeDuplicateConfirm),
          ),
        ],
      ),
    );
    return answer ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = _l10n;
    final theme = Theme.of(context);
    final titles = [
      l10n.storeWizardName,
      l10n.storeWizardCategory,
      l10n.storeWizardLocation,
      l10n.storeWizardContact,
      l10n.storeWizardPhotos,
    ];
    return Scaffold(
      appBar: AppBar(title: Text(l10n.storeWizardTitle)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Text(
            l10n.storeWizardStep(
              localizeDigits('${_step + 1}', _locale),
              localizeDigits('$_steps', _locale),
            ),
            style: theme.textTheme.labelLarge,
          ),
          const SizedBox(height: AppSpacing.xs),
          LinearProgressIndicator(value: (_step + 1) / _steps),
          const SizedBox(height: AppSpacing.md),
          Text(titles[_step], style: theme.textTheme.titleLarge),
          const SizedBox(height: AppSpacing.md),
          ...switch (_step) {
            0 => _nameStep(),
            1 => _categoryStep(),
            2 => _locationStep(),
            3 => _contactStep(),
            _ => _photoStep(),
          },
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.md),
              child: Text(
                _error!,
                key: const ValueKey('store-wizard-error'),
                style: TextStyle(color: theme.colorScheme.error),
              ),
            ),
          const SizedBox(height: AppSpacing.lg),
          Row(
            children: [
              if (_step > 0)
                TextButton(
                  onPressed: _submitting
                      ? null
                      : () => setState(() {
                          _step--;
                          _error = null;
                        }),
                  child: Text(l10n.storeWizardBack),
                ),
              const Spacer(),
              AppButton(
                key: const ValueKey('store-wizard-next'),
                label: _step == _steps - 1
                    ? l10n.storeWizardSubmit
                    : l10n.storeWizardNext,
                isLoading: _submitting,
                onPressed: _submitting || _uploading != null ? null : _next,
              ),
            ],
          ),
        ],
      ),
    );
  }

  List<Widget> _nameStep() => [
    TextField(
      key: const ValueKey('store-name-bn'),
      controller: _nameBn,
      decoration: InputDecoration(labelText: _l10n.storeFieldNameBn),
      textInputAction: TextInputAction.next,
    ),
    const SizedBox(height: AppSpacing.sm),
    TextField(
      key: const ValueKey('store-name-en'),
      controller: _nameEn,
      decoration: InputDecoration(labelText: _l10n.storeFieldNameEn),
    ),
    const SizedBox(height: AppSpacing.sm),
    TextField(
      controller: _description,
      decoration: InputDecoration(labelText: _l10n.storeFieldDescription),
      maxLines: 3,
    ),
  ];

  List<Widget> _categoryStep() {
    final categories = ref.watch(storeCategoriesProvider);
    return switch (categories) {
      AsyncData(:final value) => [
        RadioGroup<String>(
          groupValue: _categoryId,
          onChanged: (id) => setState(() {
            _categoryId = id;
            _error = null;
          }),
          child: Column(
            children: [
              for (final c in value)
                RadioListTile<String>(
                  key: ValueKey('store-category-${c.slug}'),
                  value: c.id,
                  title: Text(c.name.of(_locale)),
                ),
            ],
          ),
        ),
      ],
      AsyncError() => [Text(_l10n.storeErrorGeneric)],
      _ => [const Center(child: CircularProgressIndicator())],
    };
  }

  List<Widget> _locationStep() => [
    OutlinedButton.icon(
      key: const ValueKey('store-pick-location'),
      icon: Icon(
        _location == null
            ? Icons.add_location_alt_outlined
            : Icons.check_circle,
      ),
      label: Text(
        _location == null ? _l10n.storeUseMyLocation : _l10n.storeLocationSet,
      ),
      onPressed: () => unawaited(_pickLocation()),
    ),
    const SizedBox(height: AppSpacing.sm),
    TextField(
      key: const ValueKey('store-address'),
      controller: _address,
      decoration: InputDecoration(labelText: _l10n.storeFieldAddress),
    ),
  ];

  List<Widget> _contactStep() => [
    TextField(
      key: const ValueKey('store-phone'),
      controller: _phone,
      keyboardType: TextInputType.phone,
      decoration: InputDecoration(labelText: _l10n.storeFieldPhone),
    ),
    const SizedBox(height: AppSpacing.sm),
    TextField(
      key: const ValueKey('store-whatsapp'),
      controller: _whatsapp,
      keyboardType: TextInputType.phone,
      decoration: InputDecoration(labelText: _l10n.storeFieldWhatsapp),
    ),
  ];

  List<Widget> _photoStep() => [
    for (final (which, label, id) in [
      ('logo', _l10n.storeFieldLogo, _logoId),
      ('banner', _l10n.storeFieldBanner, _bannerId),
    ])
      ListTile(
        key: ValueKey('store-photo-$which'),
        contentPadding: EdgeInsets.zero,
        leading: Icon(
          id == null ? Icons.add_photo_alternate_outlined : Icons.check_circle,
        ),
        title: Text(label),
        subtitle: _uploading == which ? Text(_l10n.storePhotoUploading) : null,
        trailing: TextButton(
          onPressed: _uploading != null
              ? null
              : () => unawaited(_pickPhoto(which)),
          child: Text(_l10n.storePickPhoto),
        ),
      ),
  ];
}
