import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../media/thumbhash_image.dart';

/// A server photo: its thumbhash placeholder at once, then the image from
/// the disk cache or the network, decoded at [decodeWidth] logical pixels
/// (× device pixel ratio) — never at the file's own size. Pass the card
/// variant's URL in lists; only the full-screen gallery asks for the full
/// variant (ADR 038).
class NetworkPhoto extends StatelessWidget {
  const NetworkPhoto({
    required this.url,
    super.key,
    this.thumbhash,
    this.decodeWidth,
    this.fit = BoxFit.cover,
    this.semanticLabel,
  });

  final String? url;
  final String? thumbhash;

  /// Logical width it will be shown at; null = decode at full size (the
  /// zoomable gallery only).
  final double? decodeWidth;
  final BoxFit fit;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final placeholder = _Placeholder(thumbhash: thumbhash, fit: fit);
    final url = this.url;
    if (url == null) return placeholder;
    final override = NetworkPhotoOverride.maybeOf(context);
    if (override != null) return override(url, placeholder);

    final pixels = decodeWidth == null
        ? null
        : (decodeWidth! * MediaQuery.devicePixelRatioOf(context)).round();
    return Semantics(
      image: true,
      label: semanticLabel,
      child: CachedNetworkImage(
        imageUrl: url,
        fit: fit,
        memCacheWidth: pixels,
        fadeInDuration: const Duration(milliseconds: 150),
        fadeOutDuration: Duration.zero,
        placeholder: (_, _) => placeholder,
        errorWidget: (_, _, _) => _Placeholder(
          thumbhash: thumbhash,
          fit: fit,
          icon: Icons.broken_image_outlined,
        ),
      ),
    );
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.thumbhash, required this.fit, this.icon});

  final String? thumbhash;
  final BoxFit fit;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final hash = ThumbhashImages.of(thumbhash);
    return Stack(
      fit: StackFit.expand,
      children: [
        if (hash != null)
          Image(image: hash, fit: fit, gaplessPlayback: true)
        else
          ColoredBox(color: colors.surfaceContainerHighest),
        if (icon != null || (hash == null && thumbhash == null))
          Center(
            child: Icon(
              icon ?? Icons.image_outlined,
              color: colors.onSurfaceVariant,
            ),
          ),
      ],
    );
  }
}

/// How photos load under this widget — widget tests and goldens replace the
/// network and the disk cache with a builder of their own.
class NetworkPhotoOverride extends InheritedWidget {
  const NetworkPhotoOverride({
    required this.builder,
    required super.child,
    super.key,
  });

  final Widget Function(String url, Widget placeholder) builder;

  static Widget Function(String url, Widget placeholder)? maybeOf(
    BuildContext context,
  ) => context
      .dependOnInheritedWidgetOfExactType<NetworkPhotoOverride>()
      ?.builder;

  @override
  bool updateShouldNotify(NetworkPhotoOverride oldWidget) =>
      builder != oldWidget.builder;
}
