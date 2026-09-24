import 'package:flutter/material.dart';

/// Font family for the whole app — Noto Sans Bengali (variable font, `wdth`/`wght`
/// axes), which also carries basic Latin coverage for the `en` locale and
/// numerals, so one family serves both without a second bundled font.
const String appFontFamily = 'NotoSansBengali';

/// Bengali matras and conjuncts (e.g. রু, ক্ট) extend above and below typical
/// Latin ascender/descender metrics. A Latin-tuned line height (~1.2, what
/// Material's default type scale uses) clips them — the top of a matra or
/// the loop of a conjunct gets cut off. `1.5` gives Bengali glyphs room
/// without looking obviously loose for Latin text. Don't "tighten" this
/// back down without checking Bengali rendering first.
const double _bengaliLineHeight = 1.5;

TextStyle _style({
  required double size,
  required FontWeight weight,
  double? letterSpacing,
}) {
  return TextStyle(
    fontFamily: appFontFamily,
    fontSize: size,
    fontWeight: weight,
    height: _bengaliLineHeight,
    letterSpacing: letterSpacing ?? 0,
  );
}

/// The app's type scale, field-named to match `TextTheme` so [AppTheme] can
/// map it in directly. Call sites use `Theme.of(context).textTheme.titleMedium`
/// (or these constants directly in non-widget code) — never an ad hoc `TextStyle`.
abstract final class AppTypography {
  static final TextStyle displayLarge = _style(
    size: 40,
    weight: FontWeight.w600,
  );
  static final TextStyle displayMedium = _style(
    size: 32,
    weight: FontWeight.w600,
  );
  static final TextStyle headlineLarge = _style(
    size: 28,
    weight: FontWeight.w600,
  );
  static final TextStyle headlineMedium = _style(
    size: 24,
    weight: FontWeight.w600,
  );
  static final TextStyle titleLarge = _style(size: 20, weight: FontWeight.w600);
  static final TextStyle titleMedium = _style(
    size: 17,
    weight: FontWeight.w500,
  );
  static final TextStyle bodyLarge = _style(size: 16, weight: FontWeight.w400);
  static final TextStyle bodyMedium = _style(size: 14, weight: FontWeight.w400);
  static final TextStyle bodySmall = _style(size: 12, weight: FontWeight.w400);
  static final TextStyle labelLarge = _style(
    size: 14,
    weight: FontWeight.w500,
    letterSpacing: 0.1,
  );
  static final TextStyle labelMedium = _style(
    size: 12,
    weight: FontWeight.w500,
    letterSpacing: 0.1,
  );
  static final TextStyle labelSmall = _style(
    size: 11,
    weight: FontWeight.w500,
    letterSpacing: 0.1,
  );

  /// Without this, the *first* line of any tall-glyph-script text (Bengali
  /// here) gets clipped at the top: Flutter's default line-height behavior
  /// applies the height box to the first line's ascent too, and a script
  /// with taller-than-Latin ascenders overflows it. This is the standard
  /// Flutter fix — set once on the app's root `Theme`/`DefaultTextStyle`,
  /// not per-widget.
  static const TextHeightBehavior heightBehavior = TextHeightBehavior(
    applyHeightToFirstAscent: false,
    applyHeightToLastDescent: false,
  );
}
