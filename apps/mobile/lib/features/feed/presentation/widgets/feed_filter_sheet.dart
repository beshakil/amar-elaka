import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_bottom_sheet.dart';
import '../../../../core/design/widgets/app_button.dart';
import '../../../../core/dynamic_form/dynamic_filters.dart';
import '../../../../core/dynamic_form/field_schema.dart';
import '../../../../core/dynamic_form/filters.dart';
import '../../../../l10n/app_localizations.dart';

/// What the sheet hands back when the viewer applies it.
typedef AppliedFilters = ({
  Map<String, Object?> state,
  List<RawFieldFilter> filters,
});

/// The category's filter panel in a bottom sheet: the same schema-driven
/// renderer the web and the form preview use ([DynamicFilters]). Nothing
/// changes in the feed until "show results"; a panel with problems (e.g.
/// min above max) can't be applied.
abstract final class FeedFilterSheet {
  static Future<AppliedFilters?> show(
    BuildContext context, {
    required String categoryName,
    required CategoryFieldSchema schema,
    required Map<String, Object?> initialState,
  }) => AppBottomSheet.show<AppliedFilters>(
    context,
    isScrollControlled: true,
    builder: (context) => _FilterSheetBody(
      categoryName: categoryName,
      schema: schema,
      initialState: initialState,
    ),
  );
}

class _FilterSheetBody extends StatefulWidget {
  const _FilterSheetBody({
    required this.categoryName,
    required this.schema,
    required this.initialState,
  });

  final String categoryName;
  final CategoryFieldSchema schema;
  final Map<String, Object?> initialState;

  @override
  State<_FilterSheetBody> createState() => _FilterSheetBodyState();
}

class _FilterSheetBodyState extends State<_FilterSheetBody> {
  late Map<String, Object?> _state = Map.of(widget.initialState);
  late FilterResult _result = toRawFilters(widget.schema, _state);

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final height = MediaQuery.sizeOf(context).height;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: height * 0.8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            l10n.feedFilterTitle(widget.categoryName),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: AppSpacing.md),
          Flexible(
            child: SingleChildScrollView(
              padding: EdgeInsets.only(
                bottom: MediaQuery.viewInsetsOf(context).bottom,
              ),
              child: DynamicFilters(
                schema: widget.schema,
                initialState: widget.initialState,
                onChanged: (state, result) => setState(() {
                  _state = state;
                  _result = result;
                }),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          AppButton(
            key: const ValueKey('feed-filter-apply'),
            label: l10n.feedFilterApply,
            onPressed: _result.issues.isEmpty
                ? () => Navigator.of(
                    context,
                  ).pop((state: _state, filters: _result.filters))
                : null,
          ),
        ],
      ),
    );
  }
}
