import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart' as api;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens/app_colors.dart';
import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/map/location_picker.dart';
import '../../../../core/network/api_exception.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/current_tenant.dart';
import '../../application/post_editor.dart';
import '../../data/posts_api.dart';
import 'step_gate.dart';

/// Step 4: where the post is — the shared [LocationPicker] (ADR 046) with
/// `purpose=post_location`. The point and the address text the user kept
/// (or edited) are saved to the draft; each settled point is also checked
/// against the area's boundary — outside it is a warning, never a block (the
/// server places the post in the right area).
class LocationStep extends ConsumerStatefulWidget {
  const LocationStep({
    required this.editor,
    required this.gate,
    this.pickerController,
    super.key,
  });

  final PostEditor editor;
  final StepGate gate;

  /// Tests drive the camera through it (no native map in widget tests).
  final LocationPickerController? pickerController;

  @override
  ConsumerState<LocationStep> createState() => _LocationStepState();
}

class _LocationStepState extends ConsumerState<LocationStep> {
  api.PostOwnership? _ownership;
  int _check = 0;
  bool _showRequired = false;

  @override
  void initState() {
    super.initState();
    widget.gate.register(_gate);
  }

  @override
  void dispose() {
    widget.gate.unregister(_gate);
    super.dispose();
  }

  bool _gate() {
    final ok = widget.editor.draft!.hasLocation;
    setState(() => _showRequired = !ok);
    return ok;
  }

  void _onChanged(PickedLocation picked) {
    widget.editor.update(
      (d) => d.copyWith(
        lat: picked.point.lat,
        lng: picked.point.lng,
        addressLabel: picked.label,
      ),
    );
    if (_showRequired) setState(() => _showRequired = false);
  }

  /// Inside the area or not, for the warning; the latest point wins.
  Future<void> _checkOwnership(GeoPoint point) async {
    final id = ++_check;
    try {
      final ownership = await ref
          .read(postsApiProvider)
          .ownership(point.lat, point.lng);
      if (mounted && id == _check) setState(() => _ownership = ownership);
    } on AppException {
      if (mounted && id == _check) setState(() => _ownership = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final tenantName = ref.watch(currentTenantConfigProvider)?.nameBn ?? '';
    final draft = widget.editor.draft!;
    final warningColors = theme.brightness == Brightness.dark
        ? AppColors.dark
        : AppColors.light;

    return LocationPicker(
      purpose: 'post_location',
      initial: draft.hasLocation ? (lat: draft.lat!, lng: draft.lng!) : null,
      controller: widget.pickerController,
      onChanged: _onChanged,
      onPointSettled: (point) => unawaited(_checkOwnership(point)),
      below: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_ownership case final ownership? when ownership.outsideBoundary)
            Container(
              key: const ValueKey('location-outside-warning'),
              margin: const EdgeInsets.only(top: AppSpacing.sm),
              padding: const EdgeInsets.all(AppSpacing.sm),
              decoration: BoxDecoration(
                color: warningColors.warning.withValues(alpha: 0.15),
                borderRadius: AppRadii.mdRadius,
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.warning_amber_rounded,
                    color: warningColors.warning,
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      [
                        l10n.postLocationOutsideWarning(tenantName),
                        if (ownership.needsReview) l10n.postLocationNeedsReview,
                      ].join(' '),
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                ],
              ),
            ),
          if (_showRequired)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                l10n.postLocationRequired,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
