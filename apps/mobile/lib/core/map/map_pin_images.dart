import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// The Map tab's pins as style images (ADR 046): icons only, drawn once by
/// Flutter from the Material icon font and handed to MapLibre with
/// `addImage` — no sprite sheet to ship, and every pin is one GPU symbol
/// however many are on screen.
///
/// Names on pins are images too: Flutter shapes Bengali correctly, MapLibre's
/// glyph-by-glyph text does not (the shaping spike, ADR 043, has not passed),
/// so the map never draws a Bengali name itself.
abstract final class MapPinImages {
  /// `map_kinds` icon keys the app knows; anything else gets [fallback].
  static const Map<String, IconData> icons = {
    'hospital': Icons.local_hospital,
    'pharmacy': Icons.local_pharmacy,
    'food': Icons.restaurant,
    'gas': Icons.local_gas_station,
    'bank': Icons.account_balance,
    'bus': Icons.directions_bus,
    'shop': Icons.storefront,
    'listing': Icons.sell,
  };
  static const IconData fallback = Icons.place;

  /// Presentation: one colour per icon, readable on both map themes.
  static const Map<String, Color> colours = {
    'hospital': Color(0xFFE03131),
    'pharmacy': Color(0xFF2F9E44),
    'food': Color(0xFFF08C00),
    'gas': Color(0xFF1971C2),
    'bank': Color(0xFF5F3DC4),
    'bus': Color(0xFF0C8599),
    'shop': Color(0xFF1C7ED6),
    'listing': Color(0xFFD6336C),
  };
  static const Color fallbackColour = Color(0xFF495057);

  static IconData iconFor(String? key) => icons[key] ?? fallback;
  static Color colourFor(String? key) => colours[key] ?? fallbackColour;

  /// Style image name for an icon key.
  static String imageName(String? key) => 'ae-pin-${key ?? 'default'}';

  /// A round pin: a white-ringed coloured disc with the icon, [logicalSize]
  /// points across at [pixelRatio].
  static Future<Uint8List> pin(
    String? key, {
    required double pixelRatio,
    double logicalSize = 30,
  }) async {
    final size = logicalSize * pixelRatio;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final centre = Offset(size / 2, size / 2);
    canvas.drawCircle(centre, size / 2, Paint()..color = Colors.white);
    canvas.drawCircle(
      centre,
      size / 2 - 2 * pixelRatio,
      Paint()..color = colourFor(key),
    );
    final icon = iconFor(key);
    final painter = TextPainter(
      text: TextSpan(
        text: String.fromCharCode(icon.codePoint),
        style: TextStyle(
          fontFamily: icon.fontFamily,
          package: icon.fontPackage,
          fontSize: size * 0.58,
          color: Colors.white,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    painter.paint(
      canvas,
      centre - Offset(painter.width / 2, painter.height / 2),
    );
    return _png(recorder, size, size);
  }

  /// A name label: Bengali (or any) text shaped by Flutter, on a rounded
  /// pill, as an image MapLibre places under the pin.
  static Future<Uint8List> label(
    String text, {
    required double pixelRatio,
    required TextStyle style,
    required Color background,
    double maxLogicalWidth = 140,
  }) async {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: style.copyWith(fontSize: (style.fontSize ?? 12) * pixelRatio),
      ),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      ellipsis: '…',
    )..layout(maxWidth: maxLogicalWidth * pixelRatio);
    final padX = 6 * pixelRatio;
    final padY = 3 * pixelRatio;
    final width = painter.width + 2 * padX;
    final height = painter.height + 2 * padY;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(0, 0, width, height),
        Radius.circular(height / 2),
      ),
      Paint()..color = background,
    );
    painter.paint(canvas, Offset(padX, padY));
    return _png(recorder, width, height);
  }

  static Future<Uint8List> _png(
    ui.PictureRecorder recorder,
    double width,
    double height,
  ) async {
    final image = await recorder.endRecording().toImage(
      width.ceil(),
      height.ceil(),
    );
    try {
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      return bytes!.buffer.asUint8List();
    } finally {
      image.dispose();
    }
  }
}

/// Name images on the map, by slot (ADR 046). MapLibre cannot remove a
/// style image, but adding one under an existing name replaces it — so there
/// are at most `map_pin_label_max` images, `ae-label-0` … `ae-label-{max-1}`,
/// and the least recently used slot is redrawn for a new name. A long session
/// never grows the map's image memory (2 GB phones).
class PinLabelCache {
  PinLabelCache();

  /// featureId → slot, least recently used first.
  final _slots = <String, int>{};

  static String imageName(int slot) => 'ae-label-$slot';

  /// The slot for [featureId] and whether its image must be (re)drawn: a
  /// feature already holding a slot keeps it; else a free slot, else the
  /// least recently used one is taken over.
  ({int slot, bool draw}) assign(String featureId, int max) {
    final held = _slots.remove(featureId);
    if (held != null) {
      _slots[featureId] = held;
      return (slot: held, draw: false);
    }
    final used = _slots.values.toSet();
    for (var slot = 0; slot < max; slot++) {
      if (!used.contains(slot)) {
        _slots[featureId] = slot;
        return (slot: slot, draw: true);
      }
    }
    final oldest = _slots.keys.first;
    final slot = _slots.remove(oldest)!;
    _slots[featureId] = slot;
    return (slot: slot, draw: true);
  }

  /// After a style reload every image is gone.
  void clear() => _slots.clear();

  int get length => _slots.length;
}
