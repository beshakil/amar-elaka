import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_button.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';
import 'post_card.dart';

/// A post opened: photos, title, price, place, description, every detail,
/// and how to reach the seller. In the preview the contact buttons are
/// shown but do nothing ([interactive] false).
class PostDetailView extends StatelessWidget {
  const PostDetailView({
    required this.data,
    super.key,
    this.interactive = true,
    this.onCall,
    this.onChat,
    this.onWhatsapp,
  });

  final PostDisplayData data;
  final bool interactive;
  final VoidCallback? onCall;
  final VoidCallback? onChat;
  final VoidCallback? onWhatsapp;

  static const photoHeight = 220.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final text = theme.textTheme;
    final muted = text.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final meta = [?data.placeLabel, ?data.postedLabel].join(' · ');

    Widget section(String title, Widget child) => Padding(
      padding: const EdgeInsets.only(top: AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: text.titleSmall),
          const SizedBox(height: AppSpacing.sm),
          child,
        ],
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Photos(data: data, height: photoHeight),
        const SizedBox(height: AppSpacing.md),
        Text(data.title, style: text.titleLarge),
        const SizedBox(height: AppSpacing.xs),
        Text(
          data.isSold
              ? l10n.postCardSold
              : (data.priceLabel ?? l10n.postPriceOnRequest),
          style: text.headlineSmall?.copyWith(
            color: theme.colorScheme.primary,
            fontWeight: FontWeight.w700,
          ),
        ),
        if (meta.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.xs),
          Row(
            children: [
              Icon(
                Icons.place_outlined,
                size: 16,
                color: theme.colorScheme.onSurfaceVariant,
              ),
              const SizedBox(width: AppSpacing.xs),
              Expanded(child: Text(meta, style: muted)),
            ],
          ),
        ],
        if (data.description case final description?)
          section(
            l10n.postDetailDescription,
            Text(description, style: text.bodyMedium),
          ),
        if (data.details.isNotEmpty)
          section(
            l10n.postDetailDetails,
            Column(
              children: [
                for (final (label, value) in data.details)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      vertical: AppSpacing.xs,
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(flex: 2, child: Text(label, style: muted)),
                        Expanded(
                          flex: 3,
                          child: Text(value, style: text.bodyMedium),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        section(
          l10n.postDetailContact,
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (data.contactName case final name? when name.isNotEmpty)
                Text(name, style: text.titleMedium),
              if (data.contactPhone case final phone?
                  when phone.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.xs),
                Text(
                  localizeDigits(
                    phone.replaceFirst(RegExp(r'^\+88'), ''),
                    locale,
                  ),
                  style: text.bodyLarge,
                ),
                const SizedBox(height: AppSpacing.sm),
                AppButton(
                  label: l10n.postDetailCall,
                  icon: Icons.call_outlined,
                  onPressed: interactive ? onCall : null,
                ),
                if (data.showWhatsapp) ...[
                  const SizedBox(height: AppSpacing.sm),
                  AppButton(
                    label: l10n.postDetailWhatsapp,
                    icon: Icons.chat_outlined,
                    variant: AppButtonVariant.secondary,
                    onPressed: interactive ? onWhatsapp : null,
                  ),
                ],
              ] else ...[
                const SizedBox(height: AppSpacing.xs),
                Text(l10n.postDetailPhoneHidden, style: muted),
              ],
              if (data.allowChat) ...[
                const SizedBox(height: AppSpacing.sm),
                AppButton(
                  label: l10n.postDetailChat,
                  icon: Icons.forum_outlined,
                  variant: AppButtonVariant.secondary,
                  onPressed: interactive ? onChat : null,
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _Photos extends StatelessWidget {
  const _Photos({required this.data, required this.height});

  final PostDisplayData data;
  final double height;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final pixels =
        (MediaQuery.sizeOf(context).width *
                MediaQuery.devicePixelRatioOf(context))
            .round();
    if (data.photos.isEmpty) {
      return ClipRRect(
        borderRadius: AppRadii.lgRadius,
        child: Container(
          height: height,
          color: theme.colorScheme.surfaceContainerHighest,
          alignment: Alignment.center,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.image_outlined,
                size: 40,
                color: theme.colorScheme.onSurfaceVariant,
              ),
              Text(l10n.postNoPhotos, style: theme.textTheme.bodySmall),
            ],
          ),
        ),
      );
    }
    return ClipRRect(
      borderRadius: AppRadii.lgRadius,
      child: SizedBox(
        height: height,
        // PageView builds only the visible page (and its neighbour): one
        // full-width decode at a time, however many photos there are.
        child: PageView.builder(
          itemCount: data.photos.length,
          itemBuilder: (context, index) => Stack(
            fit: StackFit.expand,
            children: [
              Image(
                image: ResizeImage(
                  data.photos[index],
                  width: pixels,
                  policy: ResizeImagePolicy.fit,
                ),
                fit: BoxFit.cover,
                errorBuilder: (context, _, _) => ColoredBox(
                  color: theme.colorScheme.surfaceContainerHighest,
                ),
              ),
              Positioned(
                right: AppSpacing.sm,
                bottom: AppSpacing.sm,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: theme.colorScheme.inverseSurface.withValues(
                      alpha: 0.7,
                    ),
                    borderRadius: AppRadii.fullRadius,
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.sm,
                      vertical: AppSpacing.xxs,
                    ),
                    child: Text(
                      localizeDigits(
                        '${index + 1}/${data.photos.length}',
                        locale,
                      ),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onInverseSurface,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
