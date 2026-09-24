import 'package:flutter/material.dart';

/// One semantically-named color set. Call sites reach for `AppColors.of(context).brandPrimary`
/// (via [AppColorsTheme]) or, during setup, `AppColors.light`/`AppColors.dark` directly —
/// never a raw `Color(0x...)` literal.
@immutable
class AppColorScheme {
  const AppColorScheme({
    required this.brandPrimary,
    required this.onBrandPrimary,
    required this.brandSecondary,
    required this.onBrandSecondary,
    required this.surface,
    required this.onSurface,
    required this.surfaceVariant,
    required this.onSurfaceVariant,
    required this.background,
    required this.onBackground,
    required this.outline,
    required this.success,
    required this.onSuccess,
    required this.warning,
    required this.onWarning,
    required this.danger,
    required this.onDanger,
    required this.shimmerBase,
    required this.shimmerHighlight,
  });

  final Color brandPrimary;
  final Color onBrandPrimary;
  final Color brandSecondary;
  final Color onBrandSecondary;
  final Color surface;
  final Color onSurface;
  final Color surfaceVariant;
  final Color onSurfaceVariant;
  final Color background;
  final Color onBackground;
  final Color outline;
  final Color success;
  final Color onSuccess;
  final Color warning;
  final Color onWarning;
  final Color danger;
  final Color onDanger;
  final Color shimmerBase;
  final Color shimmerHighlight;
}

/// Brand green (civic, agricultural association) as primary; the rest is a
/// standard Material-adjacent semantic set. Swap these two palettes to
/// re-theme the whole app — nothing downstream reaches for a raw hex value.
abstract final class AppColors {
  static const light = AppColorScheme(
    brandPrimary: Color(0xFF0B6E4F),
    onBrandPrimary: Color(0xFFFFFFFF),
    brandSecondary: Color(0xFF945200),
    onBrandSecondary: Color(0xFFFFFFFF),
    surface: Color(0xFFFFFFFF),
    onSurface: Color(0xFF1A1C1A),
    surfaceVariant: Color(0xFFF0F2EE),
    onSurfaceVariant: Color(0xFF41483F),
    background: Color(0xFFF7F9F5),
    onBackground: Color(0xFF1A1C1A),
    outline: Color(0xFFD8DED2),
    success: Color(0xFF1E8E3E),
    onSuccess: Color(0xFFFFFFFF),
    warning: Color(0xFFB25E00),
    onWarning: Color(0xFFFFFFFF),
    danger: Color(0xFFB3261E),
    onDanger: Color(0xFFFFFFFF),
    shimmerBase: Color(0xFFE7EAE3),
    shimmerHighlight: Color(0xFFF5F7F2),
  );

  static const dark = AppColorScheme(
    brandPrimary: Color(0xFF6FDBA8),
    onBrandPrimary: Color(0xFF00391F),
    brandSecondary: Color(0xFFFFB871),
    onBrandSecondary: Color(0xFF4A2900),
    surface: Color(0xFF15170F),
    onSurface: Color(0xFFE2E4DC),
    surfaceVariant: Color(0xFF23261E),
    onSurfaceVariant: Color(0xFFC2C8BA),
    background: Color(0xFF101210),
    onBackground: Color(0xFFE2E4DC),
    outline: Color(0xFF3B4034),
    success: Color(0xFF7FDB9C),
    onSuccess: Color(0xFF00390F),
    warning: Color(0xFFFFB871),
    onWarning: Color(0xFF4A2900),
    danger: Color(0xFFFFB4A9),
    onDanger: Color(0xFF680003),
    shimmerBase: Color(0xFF23261E),
    shimmerHighlight: Color(0xFF2E3227),
  );

  static AppColorScheme of(Brightness brightness) =>
      brightness == Brightness.dark ? dark : light;
}
