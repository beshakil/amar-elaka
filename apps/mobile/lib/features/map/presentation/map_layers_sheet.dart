import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/map/map_pin_images.dart';
import '../../../l10n/app_localizations.dart';

/// What the layer sheet chose.
typedef MapLayerChoice = ({Set<String> kinds, bool openNow});

/// The Map tab's layer toggles (ADR 046): one row per `map_kinds` entry —
/// hospital, pharmacy, food, gas, bank, bus stand, shops, listings — with
/// its pin icon, plus "open now". At least one kind stays on. Returns null
/// when dismissed without a change.
Future<MapLayerChoice?> showMapLayersSheet(
  BuildContext context, {
  required List<api.MapKind> kinds,
  required Set<String> selected,
  required bool openNow,
}) => showModalBottomSheet<MapLayerChoice>(
  context: context,
  showDragHandle: true,
  isScrollControlled: true,
  builder: (_) =>
      _MapLayersSheet(kinds: kinds, selected: selected, openNow: openNow),
);

class _MapLayersSheet extends StatefulWidget {
  const _MapLayersSheet({
    required this.kinds,
    required this.selected,
    required this.openNow,
  });

  final List<api.MapKind> kinds;
  final Set<String> selected;
  final bool openNow;

  @override
  State<_MapLayersSheet> createState() => _MapLayersSheetState();
}

class _MapLayersSheetState extends State<_MapLayersSheet> {
  late final Set<String> _selected = {...widget.selected};
  late bool _openNow = widget.openNow;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
        child: Column(
          key: const ValueKey('map-layers-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l10n.mapLayersTitle, style: theme.textTheme.titleMedium),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.xs,
              children: [
                for (final kind in widget.kinds)
                  FilterChip(
                    key: ValueKey('map-kind-${kind.code}'),
                    avatar: Icon(
                      MapPinImages.iconFor(kind.icon),
                      color: MapPinImages.colourFor(kind.icon),
                      size: 18,
                    ),
                    label: Text(locale == 'bn' ? kind.label.bn : kind.label.en),
                    selected: _selected.contains(kind.code),
                    onSelected: (on) {
                      if (!on && _selected.length == 1) return;
                      setState(
                        () => on
                            ? _selected.add(kind.code)
                            : _selected.remove(kind.code),
                      );
                    },
                  ),
              ],
            ),
            SwitchListTile(
              key: const ValueKey('map-open-now'),
              contentPadding: EdgeInsets.zero,
              secondary: const Icon(Icons.schedule),
              title: Text(l10n.mapOpenNow),
              value: _openNow,
              onChanged: (on) => setState(() => _openNow = on),
            ),
            FilledButton(
              key: const ValueKey('map-layers-apply'),
              onPressed: () => Navigator.of(
                context,
              ).pop<MapLayerChoice>((kinds: _selected, openNow: _openNow)),
              child: Text(l10n.mapSearchThisArea),
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
        ),
      ),
    );
  }
}
