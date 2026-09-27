import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/network_photo.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';

/// The detail page's swipeable photos: card-size variants decoded at the
/// screen's width, one page at a time. A tap opens [FullScreenGallery] —
/// the only place the full-size variant is loaded (ADR 038).
class DetailGallery extends StatefulWidget {
  const DetailGallery({required this.media, required this.title, super.key});

  final List<DetailMedia> media;
  final String title;

  static const aspectRatio = 4 / 3;

  @override
  State<DetailGallery> createState() => _DetailGalleryState();
}

class _DetailGalleryState extends State<DetailGallery> {
  int _page = 0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final width = MediaQuery.sizeOf(context).width;
    final media = widget.media;
    if (media.isEmpty) {
      return AspectRatio(
        aspectRatio: DetailGallery.aspectRatio,
        child: const NetworkPhoto(url: null),
      );
    }
    return AspectRatio(
      aspectRatio: DetailGallery.aspectRatio,
      child: Stack(
        fit: StackFit.expand,
        children: [
          PageView.builder(
            key: const ValueKey('detail-gallery'),
            itemCount: media.length,
            onPageChanged: (page) => setState(() => _page = page),
            itemBuilder: (context, index) => GestureDetector(
              onTap: () => FullScreenGallery.open(
                context,
                media: media,
                initialPage: index,
                title: widget.title,
              ),
              child: NetworkPhoto(
                url: media[index].variants?.card.url,
                thumbhash: media[index].thumbhash,
                decodeWidth: width,
                semanticLabel: l10n.detailPhotoLabel(
                  widget.title,
                  localizeDigits('${index + 1}', locale),
                ),
              ),
            ),
          ),
          if (media.length > 1)
            Positioned(
              right: AppSpacing.sm,
              bottom: AppSpacing.sm,
              child: _PageBadge(
                label: l10n.detailGalleryPosition(
                  localizeDigits('${_page + 1}', locale),
                  localizeDigits('${media.length}', locale),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _PageBadge extends StatelessWidget {
  const _PageBadge({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: Colors.black.withValues(alpha: 0.6),
      borderRadius: AppRadii.fullRadius,
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: AppSpacing.xxs,
      ),
      child: Text(
        label,
        style: Theme.of(
          context,
        ).textTheme.labelMedium?.copyWith(color: Colors.white),
      ),
    ),
  );
}

/// Full-screen photos with pinch zoom (up to [maxZoom]×), swipe between
/// them while not zoomed in. Loads the full-size variant; PageView keeps
/// only the visible photo (and its neighbours) decoded.
class FullScreenGallery extends StatefulWidget {
  const FullScreenGallery({
    required this.media,
    required this.initialPage,
    required this.title,
    super.key,
  });

  final List<DetailMedia> media;
  final int initialPage;
  final String title;

  // Zoom limits: a gesture setting, not a business rule.
  static const maxZoom = 4.0;

  static Future<void> open(
    BuildContext context, {
    required List<DetailMedia> media,
    required int initialPage,
    required String title,
  }) => Navigator.of(context).push(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => FullScreenGallery(
        media: media,
        initialPage: initialPage,
        title: title,
      ),
    ),
  );

  @override
  State<FullScreenGallery> createState() => _FullScreenGalleryState();
}

class _FullScreenGalleryState extends State<FullScreenGallery> {
  late final _controller = PageController(initialPage: widget.initialPage);
  late int _page = widget.initialPage;
  bool _zoomed = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(
          l10n.detailGalleryPosition(
            localizeDigits('${_page + 1}', locale),
            localizeDigits('${widget.media.length}', locale),
          ),
        ),
      ),
      body: PageView.builder(
        key: const ValueKey('full-screen-gallery'),
        controller: _controller,
        // Swiping would fight panning a zoomed photo.
        physics: _zoomed
            ? const NeverScrollableScrollPhysics()
            : const PageScrollPhysics(),
        itemCount: widget.media.length,
        onPageChanged: (page) => setState(() => _page = page),
        itemBuilder: (context, index) {
          final media = widget.media[index];
          return _ZoomablePhoto(
            media: media,
            label: l10n.detailPhotoLabel(
              widget.title,
              localizeDigits('${index + 1}', locale),
            ),
            onZoomChanged: (zoomed) {
              if (zoomed != _zoomed) setState(() => _zoomed = zoomed);
            },
          );
        },
      ),
    );
  }
}

class _ZoomablePhoto extends StatefulWidget {
  const _ZoomablePhoto({
    required this.media,
    required this.label,
    required this.onZoomChanged,
  });

  final DetailMedia media;
  final String label;
  final ValueChanged<bool> onZoomChanged;

  @override
  State<_ZoomablePhoto> createState() => _ZoomablePhotoState();
}

class _ZoomablePhotoState extends State<_ZoomablePhoto> {
  final _transform = TransformationController();

  @override
  void initState() {
    super.initState();
    _transform.addListener(
      () => widget.onZoomChanged(_transform.value.getMaxScaleOnAxis() > 1.01),
    );
  }

  @override
  void dispose() {
    _transform.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final variants = widget.media.variants;
    final full = variants?.full;
    return InteractiveViewer(
      transformationController: _transform,
      maxScale: FullScreenGallery.maxZoom,
      child: Center(
        child: AspectRatio(
          aspectRatio: full == null
              ? DetailGallery.aspectRatio
              : full.width / full.height,
          child: NetworkPhoto(
            url: full?.url,
            thumbhash: widget.media.thumbhash,
            fit: BoxFit.contain,
            semanticLabel: widget.label,
          ),
        ),
      ),
    );
  }
}
