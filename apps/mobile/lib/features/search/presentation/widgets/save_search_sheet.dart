import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_bottom_sheet.dart';
import '../../../../core/design/widgets/app_button.dart';
import '../../../../core/network/api_exception.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../feed/application/feed_controller.dart';
import '../../../post/application/current_tenant.dart';
import '../../application/saved_searches_controller.dart';
import '../../data/saved_searches_api.dart';
import '../../domain/search_request.dart';
import '../search_labels.dart';

/// "Save this search" (ADR 041): a name (the text, or the category) and when
/// to be told. The search saves exactly as shown — text, category, field
/// values and price range — around the viewer (or the area's centre) with
/// the radius the results used. Returns the saved search, or null.
abstract final class SaveSearchSheet {
  static Future<SavedSearch?> show(
    BuildContext context, {
    required SearchRequest request,
    required double? radiusKm,
    required SearchLabels labels,
  }) => AppBottomSheet.show<SavedSearch>(
    context,
    isScrollControlled: true,
    builder: (_) =>
        _SaveSearchBody(request: request, radiusKm: radiusKm, labels: labels),
  );
}

class _SaveSearchBody extends ConsumerStatefulWidget {
  const _SaveSearchBody({
    required this.request,
    required this.radiusKm,
    required this.labels,
  });

  final SearchRequest request;
  final double? radiusKm;
  final SearchLabels labels;

  @override
  ConsumerState<_SaveSearchBody> createState() => _SaveSearchBodyState();
}

class _SaveSearchBodyState extends ConsumerState<_SaveSearchBody> {
  late final TextEditingController _name = TextEditingController(
    text: widget.request.text.isNotEmpty
        ? widget.request.text
        : widget.request.categorySlug == null
        ? ''
        : widget.labels.categoryName(widget.request.categorySlug!),
  );
  AlertFrequency _frequency = AlertFrequency.instant;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final l10n = AppLocalizations.of(context)!;
    setState(() {
      _saving = true;
      _error = null;
    });
    final tenant = ref.read(currentTenantConfigProvider);
    final position = await ref.read(viewerPositionProvider.future);
    final center = position == null
        ? tenant!.mapCenter
        : LatLng(lat: position.latitude, lng: position.longitude);
    // The radius the results used; the area's own before any results.
    final radiusKm = widget.radiusKm ?? tenant?.radiusKm;
    if (radiusKm == null) {
      setState(() {
        _saving = false;
        _error = l10n.searchSaveFailed;
      });
      return;
    }
    try {
      // Straight to the API: the list's provider may not be alive on this screen.
      final saved = await ref
          .read(savedSearchesApiProvider)
          .create(
            NewSavedSearch(
              name: _name.text.trim(),
              q: widget.request.text,
              filters: widget.request.toSavedFilters(),
              center: center,
              radiusKm: radiusKm,
              frequency: _frequency,
            ),
          );
      ref.invalidate(savedSearchesProvider);
      if (mounted) Navigator.of(context).pop(saved);
    } on AppException catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = switch (error) {
          ApiException(code: 'SAVED_SEARCH_LIMIT_REACHED', :final body) =>
            l10n.searchSaveLimit(
              widget.labels.count(
                (body.details as Map<String, dynamic>?)?['maxActive'] as int? ??
                    0,
              ),
            ),
          _ => l10n.searchSaveFailed,
        };
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l10n.searchSaveTitle, style: theme.textTheme.titleLarge),
          const SizedBox(height: AppSpacing.md),
          TextField(
            key: const ValueKey('save-search-name'),
            controller: _name,
            autocorrect: false,
            maxLength: 80,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(labelText: l10n.searchSaveNameLabel),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            l10n.searchSaveFrequencyLabel,
            style: theme.textTheme.titleSmall,
          ),
          RadioGroup<AlertFrequency>(
            groupValue: _frequency,
            onChanged: (value) => setState(() => _frequency = value!),
            child: Column(
              children: [
                for (final frequency in AlertFrequency.values)
                  RadioListTile<AlertFrequency>(
                    key: ValueKey('save-search-frequency-${frequency.api}'),
                    contentPadding: EdgeInsets.zero,
                    value: frequency,
                    title: Text(widget.labels.frequency(frequency)),
                  ),
              ],
            ),
          ),
          if (_error != null) ...[
            Text(
              _error!,
              key: const ValueKey('save-search-error'),
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
          AppButton(
            key: const ValueKey('save-search-confirm'),
            label: l10n.searchSaveConfirm,
            isLoading: _saving,
            onPressed: _name.text.trim().isEmpty || _saving ? null : _save,
          ),
        ],
      ),
    );
  }
}
