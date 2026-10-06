import 'dart:convert';

import 'package:flutter/services.dart';

/// The base map styles (docs/decisions/043-self-hosted-pmtiles-basemap.md),
/// bundled from packages/map-style (assets/map/, generated — never edit). This
/// mirrors `resolveStyle()` in packages/map-style/src/index.ts: fill in the
/// archive and asset URLs from `GET /map/config`, then write every name label
/// in the chosen language. The label rules themselves come from
/// assets/map/labels.json, so the two clients can't disagree about them.
abstract final class MapStyles {
  static const String tilesPlaceholder = '__TILES__';
  static const String assetsPlaceholder = '__ASSETS__';

  /// Marks a symbol layer whose text is a name (not a road shield's ref).
  static const String labelMetadataKey = 'amar-elaka:label';

  /// The style for [dark] or light, ready to hand to MapLibre as raw JSON.
  static Future<String> load(
    AssetBundle bundle, {
    required bool dark,
    required String tilesUrl,
    required String assetsBaseUrl,
    required String labelLanguage,
  }) async {
    final (template, labels) = await (
      bundle.loadString('assets/map/${dark ? 'dark' : 'light'}.json'),
      bundle.loadString('assets/map/labels.json'),
    ).wait;
    return resolve(
      template,
      jsonDecode(labels) as Map<String, dynamic>,
      tilesUrl: tilesUrl,
      assetsBaseUrl: assetsBaseUrl,
      labelLanguage: labelLanguage,
    );
  }

  /// Pure: [template] (a style with placeholders) → the resolved style JSON.
  static String resolve(
    String template,
    Map<String, dynamic> labels, {
    required String tilesUrl,
    required String assetsBaseUrl,
    required String labelLanguage,
  }) {
    final base = assetsBaseUrl.replaceAll(RegExp(r'/+$'), '');
    final style =
        jsonDecode(
              template
                  .replaceAll(tilesPlaceholder, tilesUrl)
                  .replaceAll(assetsPlaceholder, base),
            )
            as Map<String, dynamic>;
    final text = labels[labelLanguage] ?? labels['en'];
    for (final layer
        in (style['layers'] as List).cast<Map<String, dynamic>>()) {
      final metadata = layer['metadata'];
      if (layer['type'] != 'symbol' ||
          metadata is! Map ||
          metadata[labelMetadataKey] != true) {
        continue;
      }
      (layer['layout'] as Map<String, dynamic>)['text-field'] = text;
    }
    return jsonEncode(style);
  }
}
