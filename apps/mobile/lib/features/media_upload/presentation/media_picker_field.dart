import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/design/tokens/app_radii.dart';
import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/tokens/app_typography.dart';
import '../../../core/design/widgets/app_bottom_sheet.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../l10n/app_localizations.dart';
import '../application/upload_queue.dart';
import '../domain/upload_item.dart';

/// Photos for a post: pick from camera or gallery (up to the queue's limit),
/// watch each one compress and upload, reorder by dragging (or with the
/// screen reader's "move earlier/later" actions), retry or remove. The first
/// photo is the cover.
class MediaPickerField extends StatelessWidget {
  const MediaPickerField({required this.queue, super.key, this.picker});

  final UploadQueue queue;

  /// Injectable for tests.
  final ImagePicker? picker;

  static const _tileSize = 96.0;

  Future<void> _pick(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    final picker = this.picker ?? ImagePicker();
    final source = await AppBottomSheet.show<ImageSource>(
      context,
      builder: (sheet) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppButton(
            label: l10n.mediaTakePhoto,
            icon: Icons.photo_camera_outlined,
            variant: AppButtonVariant.secondary,
            onPressed: () => Navigator.of(sheet).pop(ImageSource.camera),
          ),
          const SizedBox(height: AppSpacing.sm),
          AppButton(
            label: l10n.mediaChooseFromGallery,
            icon: Icons.photo_library_outlined,
            variant: AppButtonVariant.secondary,
            onPressed: () => Navigator.of(sheet).pop(ImageSource.gallery),
          ),
        ],
      ),
    );
    if (source == null) return;
    // No need for full metadata: location data isn't wanted anyway.
    final picked = source == ImageSource.camera
        ? [
            ?await picker.pickImage(
              source: ImageSource.camera,
              requestFullMetadata: false,
            ),
          ]
        : await picker.pickMultiImage(
            limit: queue.remainingSlots,
            requestFullMetadata: false,
          );
    await queue.add([for (final file in picked) file.path]);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return ListenableBuilder(
      listenable: queue,
      builder: (context, _) {
        final items = queue.items;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    l10n.mediaPhotosLabel,
                    style: AppTypography.labelLarge,
                  ),
                ),
                Text(
                  l10n.mediaCount(
                    localizeDigits('${items.length}', locale),
                    localizeDigits('${queue.maxItems}', locale),
                  ),
                  style: AppTypography.bodySmall,
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            SizedBox(
              height: _tileSize,
              child: ReorderableListView.builder(
                scrollDirection: Axis.horizontal,
                buildDefaultDragHandles: false,
                itemCount: items.length,
                onReorderItem: queue.reorder,
                footer: queue.remainingSlots > 0
                    ? _AddTile(size: _tileSize, onTap: () => _pick(context))
                    : null,
                itemBuilder: (context, index) => _PhotoTile(
                  key: ValueKey(items[index].id),
                  item: items[index],
                  index: index,
                  count: items.length,
                  size: _tileSize,
                  locale: locale,
                  queue: queue,
                ),
              ),
            ),
            if (queue.remainingSlots <= 0) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(l10n.mediaLimitReached, style: AppTypography.bodySmall),
            ],
          ],
        );
      },
    );
  }
}

class _AddTile extends StatelessWidget {
  const _AddTile({required this.size, required this.onTap});

  final double size;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(right: AppSpacing.sm),
      child: Semantics(
        button: true,
        label: l10n.mediaAddPhotos,
        child: InkWell(
          onTap: onTap,
          borderRadius: AppRadii.mdRadius,
          child: Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              borderRadius: AppRadii.mdRadius,
              border: Border.all(color: colors.outline),
            ),
            child: Icon(Icons.add_a_photo_outlined, color: colors.primary),
          ),
        ),
      ),
    );
  }
}

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({
    required this.item,
    required this.index,
    required this.count,
    required this.size,
    required this.locale,
    required this.queue,
    super.key,
  });

  final UploadItem item;
  final int index;
  final int count;
  final double size;
  final String locale;
  final UploadQueue queue;

  String _status(AppLocalizations l10n) => switch (item.status) {
    UploadStatus.queued => l10n.mediaStatusQueued,
    UploadStatus.compressing => l10n.mediaStatusCompressing,
    UploadStatus.uploading => l10n.mediaStatusUploading(
      localizeDigits('${(item.progress * 100).round()}', locale),
    ),
    UploadStatus.confirming => l10n.mediaStatusChecking,
    UploadStatus.done => l10n.mediaStatusDone,
    UploadStatus.failed => l10n.mediaStatusFailed,
  };

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    final path = item.compressedPath ?? item.sourcePath;
    final label = [
      l10n.mediaPhotoNumber(localizeDigits('${index + 1}', locale)),
      if (index == 0) l10n.mediaCover,
      _status(l10n),
    ].join(', ');

    return Padding(
      padding: const EdgeInsets.only(right: AppSpacing.sm),
      child: Semantics(
        label: label,
        customSemanticsActions: {
          if (index > 0)
            CustomSemanticsAction(label: l10n.mediaMoveEarlier): () =>
                queue.reorder(index, index - 1),
          if (index < count - 1)
            CustomSemanticsAction(label: l10n.mediaMoveLater): () =>
                queue.reorder(index, index + 1),
        },
        child: ReorderableDelayedDragStartListener(
          index: index,
          child: SizedBox(
            width: size,
            height: size,
            child: Stack(
              fit: StackFit.expand,
              children: [
                ClipRRect(
                  borderRadius: AppRadii.mdRadius,
                  child: Image.file(
                    File(path),
                    fit: BoxFit.cover,
                    cacheWidth: (size * 2).round(),
                    excludeFromSemantics: true,
                    errorBuilder: (_, _, _) =>
                        ColoredBox(color: colors.surfaceContainerHighest),
                  ),
                ),
                if (item.status != UploadStatus.done)
                  DecoratedBox(
                    decoration: BoxDecoration(
                      borderRadius: AppRadii.mdRadius,
                      color: colors.scrim.withValues(alpha: 0.35),
                    ),
                    child: Center(
                      child: _StatusBadge(item: item, queue: queue),
                    ),
                  ),
                if (index == 0)
                  Positioned(
                    left: AppSpacing.xs,
                    bottom: AppSpacing.xs,
                    child: ExcludeSemantics(
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: colors.primary,
                          borderRadius: AppRadii.smRadius,
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.xs,
                          ),
                          child: Text(
                            l10n.mediaCover,
                            style: AppTypography.labelSmall.copyWith(
                              color: colors.onPrimary,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                Positioned(
                  top: 0,
                  right: 0,
                  child: IconButton(
                    tooltip: l10n.mediaRemovePhoto,
                    visualDensity: VisualDensity.compact,
                    style: IconButton.styleFrom(
                      backgroundColor: colors.surface.withValues(alpha: 0.85),
                    ),
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => queue.remove(item.id),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.item, required this.queue});

  final UploadItem item;
  final UploadQueue queue;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return switch (item.status) {
      UploadStatus.failed => IconButton(
        tooltip: l10n.mediaRetry,
        style: IconButton.styleFrom(backgroundColor: colors.surface),
        icon: Icon(Icons.refresh, color: colors.error),
        onPressed: () => queue.retry(item.id),
      ),
      UploadStatus.uploading => SizedBox.square(
        dimension: 36,
        child: CircularProgressIndicator(
          value: item.progress,
          strokeWidth: 3,
          color: colors.onPrimary,
          backgroundColor: colors.onPrimary.withValues(alpha: 0.3),
        ),
      ),
      _ => SizedBox.square(
        dimension: 36,
        child: CircularProgressIndicator(
          strokeWidth: 3,
          color: colors.onPrimary,
        ),
      ),
    };
  }
}
