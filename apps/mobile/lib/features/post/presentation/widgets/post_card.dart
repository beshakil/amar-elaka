import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_card.dart';
import '../../../../core/dynamic_form/field_display.dart';
import '../../../../core/dynamic_form/field_schema.dart';
import '../../../../core/dynamic_form/form_values.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../media_upload/domain/upload_item.dart';
import '../../domain/post_draft.dart';

/// Everything a post card or detail page shows, already formatted for the
/// reader's locale — built from a draft (the preview) or from the server's
/// PostView (my posts, later the feed), so both look exactly alike.
class PostDisplayData {
  const PostDisplayData({
    required this.title,
    required this.priceLabel,
    required this.attributes,
    required this.details,
    required this.photos,
    this.description,
    this.placeLabel,
    this.postedLabel,
    this.isSold = false,
    this.contactName,
    this.contactPhone,
    this.showWhatsapp = false,
    this.allowChat = true,
  });

  factory PostDisplayData.fromDraft(
    PostDraft draft,
    List<UploadItem> uploads,
    AppLocalizations l10n,
    String locale,
  ) {
    final schema = draft.schema;
    final values = schema == null
        ? const <String, Object>{}
        : formStateToValues(schema, draft.formState);
    return PostDisplayData._fromValues(
      schema: schema,
      values: values,
      l10n: l10n,
      locale: locale,
      title: draft.title.trim(),
      description: draft.description.trim(),
      photos: [
        for (final media in draft.existingMedia)
          if (media.cardUrl case final url?) NetworkImage(url),
        for (final item in uploads)
          FileImage(File(item.compressedPath ?? item.sourcePath)),
      ],
      placeLabel: draft.addressLabel,
      postedLabel: l10n.postPostedToday,
      contactName: draft.contactName,
      contactPhone: draft.showPhone ? draft.contactPhone : null,
      showWhatsapp: draft.showPhone && draft.showWhatsapp,
      allowChat: draft.allowChat,
    );
  }

  factory PostDisplayData.fromPost(
    PostView post,
    CategoryFieldSchema? schema,
    AppLocalizations l10n,
    String locale,
  ) => PostDisplayData._fromValues(
    schema: schema,
    values: post.fields,
    l10n: l10n,
    locale: locale,
    title: post.title,
    description: post.description ?? '',
    photos: [
      for (final media in post.media)
        if (media.cardUrl case final url?) NetworkImage(url),
    ],
    isSold: post.isSold,
    contactName: post.contact.name,
    contactPhone: post.contact.phone,
    showWhatsapp: post.contact.whatsapp,
    allowChat: post.allowChat,
  );

  factory PostDisplayData._fromValues({
    required CategoryFieldSchema? schema,
    required Map<String, Object?> values,
    required AppLocalizations l10n,
    required String locale,
    required String title,
    required String description,
    required List<ImageProvider> photos,
    String? placeLabel,
    String? postedLabel,
    bool isSold = false,
    String? contactName,
    String? contactPhone,
    bool showWhatsapp = false,
    bool allowChat = true,
  }) {
    String? show(String key) => schema == null
        ? null
        : displayFieldValue(schema, key, values[key], l10n, locale);
    final details = <(String, String)>[];
    final attributes = <String>[];
    if (schema != null) {
      for (final key in schema.formFieldKeys) {
        if (key == 'price') continue;
        final shown = show(key);
        if (shown == null) continue;
        final label = schema.label(key, locale);
        details.add((label, shown));
        if (schema.card.contains(key)) attributes.add('$label $shown');
      }
    }
    return PostDisplayData(
      title: title,
      priceLabel: show('price'),
      attributes: attributes,
      details: details,
      photos: photos,
      description: description.isEmpty ? null : description,
      placeLabel: placeLabel,
      postedLabel: postedLabel,
      isSold: isSold,
      contactName: contactName,
      contactPhone: contactPhone,
      showWhatsapp: showWhatsapp,
      allowChat: allowChat,
    );
  }

  final String title;

  /// "৳ ১৫,০০০", or null (the card says "contact for price").
  final String? priceLabel;

  /// The category's card fields, "label value" (uiSchema.card).
  final List<String> attributes;

  /// Every filled field, in form order, for the detail page.
  final List<(String, String)> details;
  final List<ImageProvider> photos;
  final String? description;
  final String? placeLabel;
  final String? postedLabel;
  final bool isSold;
  final String? contactName;

  /// Null when the seller doesn't show it.
  final String? contactPhone;
  final bool showWhatsapp;
  final bool allowChat;
}

/// A post in a list: cover photo, title, price, the category's key facts,
/// place and time. Photos are decoded at display size only (cacheWidth), so
/// a list of them stays light on a 2 GB phone.
class PostCard extends StatelessWidget {
  const PostCard({required this.data, super.key, this.onTap, this.footer});

  final PostDisplayData data;
  final VoidCallback? onTap;

  /// Extra row under the card (my posts: status, reason, actions).
  final Widget? footer;

  static const photoSize = 104.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final text = theme.textTheme;
    final muted = text.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final meta = [?data.placeLabel, ?data.postedLabel].join(' · ');

    return AppCard(
      onTap: onTap,
      padding: const EdgeInsets.all(AppSpacing.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _CoverPhoto(data: data, size: photoSize),
              const SizedBox(width: AppSpacing.sm + AppSpacing.xs),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      data.title,
                      style: text.titleMedium,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      data.priceLabel ?? l10n.postPriceOnRequest,
                      style:
                          (data.priceLabel == null
                                  ? text.bodyMedium
                                  : text.titleMedium)
                              ?.copyWith(
                                color: theme.colorScheme.primary,
                                fontWeight: FontWeight.w700,
                              ),
                    ),
                    if (data.attributes.isNotEmpty) ...[
                      const SizedBox(height: AppSpacing.xs),
                      Text(
                        data.attributes.take(3).join(' · '),
                        style: text.bodySmall,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                    if (meta.isNotEmpty) ...[
                      const SizedBox(height: AppSpacing.xs),
                      Text(
                        meta,
                        style: muted,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          ?footer,
        ],
      ),
    );
  }
}

class _CoverPhoto extends StatelessWidget {
  const _CoverPhoto({required this.data, required this.size});

  final PostDisplayData data;
  final double size;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final pixels = (size * MediaQuery.devicePixelRatioOf(context)).round();
    final photo = data.photos.firstOrNull;
    return ClipRRect(
      borderRadius: AppRadii.mdRadius,
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (photo == null)
              ColoredBox(
                color: theme.colorScheme.surfaceContainerHighest,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.image_outlined,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    Text(l10n.postNoPhotos, style: theme.textTheme.labelSmall),
                  ],
                ),
              )
            else
              Image(
                image: ResizeImage(
                  photo,
                  width: pixels,
                  policy: ResizeImagePolicy.fit,
                ),
                fit: BoxFit.cover,
                errorBuilder: (context, _, _) => ColoredBox(
                  color: theme.colorScheme.surfaceContainerHighest,
                ),
              ),
            if (data.isSold)
              Align(
                alignment: Alignment.bottomCenter,
                child: Container(
                  width: double.infinity,
                  color: theme.colorScheme.inverseSurface.withValues(
                    alpha: 0.85,
                  ),
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
                  child: Text(
                    l10n.postCardSold,
                    textAlign: TextAlign.center,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.onInverseSurface,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
