import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:thumbhash/thumbhash.dart' as th;

/// Decodes the API's base64 thumbhash (≈25 bytes) into a tiny image to show
/// while the real photo loads. Decoding is cheap but not free, and a feed
/// rebuilds cards often while scrolling, so decoded placeholders are kept in
/// a small LRU keyed by the hash.
abstract final class ThumbhashImages {
  // Client-side memory tuning, not a business number: a screenful of cards
  // plus some scroll-back, each ~32×32 px.
  static const _maxEntries = 120;
  // Map literals keep insertion order: the first key is the least recent.
  static final _cache = <String, ImageProvider>{};

  /// The placeholder for [hash], or null if it can't be decoded.
  static ImageProvider? of(String? hash) {
    if (hash == null || hash.isEmpty) return null;
    final cached = _cache.remove(hash);
    if (cached != null) return _cache[hash] = cached;
    try {
      final image = th.thumbHashToRGBA(base64Decode(hash));
      final provider = MemoryImage(th.rgbaToBmp(image));
      _cache[hash] = provider;
      if (_cache.length > _maxEntries) _cache.remove(_cache.keys.first);
      return provider;
    } on Object {
      return null; // A broken hash only means no placeholder.
    }
  }
}
