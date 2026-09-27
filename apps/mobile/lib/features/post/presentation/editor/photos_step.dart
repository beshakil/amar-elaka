import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../media_upload/domain/upload_item.dart';
import '../../../media_upload/presentation/media_picker_field.dart';
import '../../application/post_editor.dart';

/// Step 3: photos — pick several, each compressed on the phone and uploaded
/// in the background with its progress; reorder by dragging, remove, retry
/// (the Month 1 upload queue, persistent across app kills).
///
/// On a low-memory Android phone the system may kill the app while the
/// camera is open; the photo taken is then handed back on the next launch
/// (`retrieveLostData`) and added here instead of being lost.
class PhotosStep extends StatefulWidget {
  const PhotosStep({required this.editor, super.key, this.picker});

  final PostEditor editor;

  /// Injectable for tests.
  final ImagePicker? picker;

  @override
  State<PhotosStep> createState() => _PhotosStepState();
}

class _PhotosStepState extends State<PhotosStep> {
  @override
  void initState() {
    super.initState();
    if (!kIsWeb && Platform.isAndroid) _recoverLostPhoto();
  }

  Future<void> _recoverLostPhoto() async {
    final lost = await (widget.picker ?? ImagePicker()).retrieveLostData();
    final files = lost.files ?? const <XFile>[];
    if (lost.isEmpty || files.isEmpty || !mounted) return;
    await widget.editor.photos.add([for (final f in files) f.path]);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(AppLocalizations.of(context)!.postPhotosRecovered),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final existing = widget.editor.draft!.existingMedia;
    return ListenableBuilder(
      listenable: widget.editor.photos,
      builder: (context, _) {
        final items = widget.editor.photos.items;
        final uploading = items
            .where(
              (i) =>
                  i.status != UploadStatus.done &&
                  i.status != UploadStatus.failed,
            )
            .length;
        final failed = items
            .where((i) => i.status == UploadStatus.failed)
            .length;
        return ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            Text(l10n.postPhotosHint, style: theme.textTheme.bodyMedium),
            const SizedBox(height: AppSpacing.md),
            if (existing.isNotEmpty) ...[
              Text(l10n.postPhotosExisting, style: theme.textTheme.labelLarge),
              const SizedBox(height: AppSpacing.sm),
              SizedBox(
                height: 96,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: existing.length,
                  separatorBuilder: (_, _) =>
                      const SizedBox(width: AppSpacing.sm),
                  itemBuilder: (context, index) {
                    final media = existing[index];
                    return ClipRRect(
                      borderRadius: AppRadii.mdRadius,
                      child: Stack(
                        children: [
                          SizedBox.square(
                            dimension: 96,
                            child: media.thumbUrl == null
                                ? ColoredBox(
                                    color: theme
                                        .colorScheme
                                        .surfaceContainerHighest,
                                  )
                                : Image.network(
                                    media.thumbUrl!,
                                    fit: BoxFit.cover,
                                    cacheWidth: 192,
                                  ),
                          ),
                          Positioned(
                            top: 0,
                            right: 0,
                            child: IconButton.filledTonal(
                              iconSize: 18,
                              tooltip: l10n.postPhotosRemoveExisting,
                              icon: const Icon(Icons.close),
                              onPressed: () => widget.editor.update(
                                (d) => d.copyWith(
                                  existingMedia: [
                                    for (final m in d.existingMedia)
                                      if (m.id != media.id) m,
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
            ],
            MediaPickerField(
              queue: widget.editor.photos,
              picker: widget.picker,
            ),
            if (uploading > 0) ...[
              const SizedBox(height: AppSpacing.md),
              Text(
                l10n.postPhotosUploading(localizeDigits('$uploading', locale)),
                style: theme.textTheme.bodySmall,
              ),
            ],
            if (failed > 0) ...[
              const SizedBox(height: AppSpacing.md),
              Text(
                l10n.postPhotosFailed(localizeDigits('$failed', locale)),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}
