import 'package:flutter/painting.dart';

/// Caps Flutter's decoded-image cache for low-RAM phones (2 GB, ADR 038).
/// Lists request card-size variants decoded at display size, so a screenful
/// of feed cards is a few MB; the full-size variant is only ever decoded in
/// the full-screen gallery. The default cache (100 MB / 1000 images) is
/// sized for devices with far more headroom.
abstract final class ImageMemory {
  // Client memory tuning, not a business rule.
  static const maxBytes = 48 << 20;
  static const maxImages = 200;

  static void configure() {
    PaintingBinding.instance.imageCache
      ..maximumSizeBytes = maxBytes
      ..maximumSize = maxImages;
  }
}
