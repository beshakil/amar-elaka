import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/design/tokens/app_spacing.dart';
import '../../core/design/tokens/app_typography.dart';
import '../../core/design/widgets/app_card.dart';
import '../../core/design/widgets/app_chip.dart';
import '../../core/dynamic_form/dynamic_filters.dart';
import '../../core/dynamic_form/dynamic_form.dart';
import '../../core/dynamic_form/field_schema.dart';
import '../../core/dynamic_form/filters.dart';
import '../../l10n/app_localizations.dart';
import '../media_upload/application/upload_queue.dart';
import '../media_upload/data/image_compressor.dart';
import '../media_upload/data/simulated_upload_transport.dart';
import '../media_upload/data/upload_queue_store.dart';
import '../media_upload/presentation/media_picker_field.dart';
import 'demo_category_schemas.g.dart';

/// Debug-only QA screen: the to-let and rent-a-car schemas from the seed
/// taxonomy rendered as a form and as filters, with exactly what would be
/// sent to the API. Registered by AppRouter in debug builds only.
class FormPreviewScreen extends StatefulWidget {
  const FormPreviewScreen({super.key});

  @override
  State<FormPreviewScreen> createState() => _FormPreviewScreenState();
}

class _FormPreviewScreenState extends State<FormPreviewScreen> {
  final List<CategorySchemaEntry> _categories = [
    for (final raw in demoCategorySchemas.values)
      CategorySchemaEntry.fromJson(jsonDecode(raw) as Map<String, dynamic>),
  ];
  late String _slug = _categories.first.slug;
  Map<String, Object>? _submitted;
  List<RawFieldFilter> _filters = const [];

  static const _json = JsonEncoder.withIndent('  ');

  /// Real on-device compression and a real persistent queue (kill the app
  /// mid-upload to see it resume), with a simulated server.
  late final UploadQueue _photos = UploadQueue(
    queueId: 'debug-form-preview',
    compressor: PluginImageCompressor(),
    transport: SimulatedUploadTransport(),
    store: PersistentUploadQueueStore(),
  )..restore();

  @override
  void dispose() {
    _photos.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final category = _categories.firstWhere((c) => c.slug == _slug);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.formPreviewTitle)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Wrap(
            spacing: AppSpacing.sm,
            children: [
              for (final c in _categories)
                AppChip(
                  label: c.name.of(locale),
                  selected: c.slug == _slug,
                  onSelected: (_) => setState(() {
                    _slug = c.slug;
                    _submitted = null;
                    _filters = const [];
                  }),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          _Heading(l10n.formPreviewPhotos),
          AppCard(child: MediaPickerField(queue: _photos)),
          ListenableBuilder(
            listenable: _photos,
            builder: (context, _) => _Output(
              title: l10n.formPreviewSubmitted,
              text: _json.convert({'mediaIds': _photos.mediaIds}),
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          _Heading(l10n.formPreviewForm(category.name.of(locale))),
          AppCard(
            child: DynamicForm(
              key: ValueKey('form-${category.slug}'),
              schema: category.schema,
              onSubmit: (values) => setState(() => _submitted = values),
            ),
          ),
          _Output(
            title: l10n.formPreviewSubmitted,
            text: _submitted == null
                ? l10n.formPreviewNothingYet
                : _json.convert(_submitted),
          ),
          const SizedBox(height: AppSpacing.lg),
          _Heading(l10n.formPreviewFilters),
          AppCard(
            child: DynamicFilters(
              key: ValueKey('filters-${category.slug}'),
              schema: category.schema,
              onChanged: (_, result) =>
                  setState(() => _filters = result.filters),
            ),
          ),
          _Output(
            title: l10n.formPreviewApiFilters,
            text: _filters.isEmpty
                ? l10n.formPreviewNothingYet
                : '${_json.convert([for (final f in _filters) f.toJson()])}'
                      '\n\n?${filtersToQuery(_filters)}',
          ),
        ],
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.sm),
    child: Semantics(
      header: true,
      child: Text(text, style: AppTypography.titleMedium),
    ),
  );
}

class _Output extends StatelessWidget {
  const _Output({required this.title, required this.text});

  final String title;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: AppSpacing.sm),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: AppTypography.labelLarge),
        const SizedBox(height: AppSpacing.xs),
        Semantics(
          liveRegion: true,
          child: SelectableText(
            text,
            style: AppTypography.bodySmall.copyWith(
              fontFamily: 'monospace',
              // Monospace fonts rarely carry Bengali glyphs.
              fontFamilyFallback: const [appFontFamily],
            ),
          ),
        ),
      ],
    ),
  );
}
