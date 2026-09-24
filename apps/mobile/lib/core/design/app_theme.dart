import 'package:flutter/material.dart';

import 'tokens/app_colors.dart';
import 'tokens/app_radii.dart';
import 'tokens/app_typography.dart';

/// Builds real `ThemeData` from the design tokens, so widgets that just use
/// `Theme.of(context)` (instead of reaching for [AppColors]/[AppTypography]
/// directly) still get the same values.
abstract final class AppTheme {
  static ThemeData light() => _build(AppColors.light, Brightness.light);
  static ThemeData dark() => _build(AppColors.dark, Brightness.dark);

  static ThemeData _build(AppColorScheme colors, Brightness brightness) {
    final colorScheme =
        ColorScheme.fromSeed(
          seedColor: colors.brandPrimary,
          brightness: brightness,
        ).copyWith(
          primary: colors.brandPrimary,
          onPrimary: colors.onBrandPrimary,
          secondary: colors.brandSecondary,
          onSecondary: colors.onBrandSecondary,
          surface: colors.surface,
          onSurface: colors.onSurface,
          surfaceContainerHighest: colors.surfaceVariant,
          onSurfaceVariant: colors.onSurfaceVariant,
          outline: colors.outline,
          error: colors.danger,
          onError: colors.onDanger,
        );

    final textTheme = TextTheme(
      displayLarge: AppTypography.displayLarge,
      displayMedium: AppTypography.displayMedium,
      headlineLarge: AppTypography.headlineLarge,
      headlineMedium: AppTypography.headlineMedium,
      titleLarge: AppTypography.titleLarge,
      titleMedium: AppTypography.titleMedium,
      bodyLarge: AppTypography.bodyLarge,
      bodyMedium: AppTypography.bodyMedium,
      bodySmall: AppTypography.bodySmall,
      labelLarge: AppTypography.labelLarge,
      labelMedium: AppTypography.labelMedium,
      labelSmall: AppTypography.labelSmall,
    ).apply(bodyColor: colors.onSurface, displayColor: colors.onSurface);

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: colors.background,
      fontFamily: appFontFamily,
      textTheme: textTheme,
      appBarTheme: AppBarTheme(
        backgroundColor: colors.surface,
        foregroundColor: colors.onSurface,
        elevation: 0,
        titleTextStyle: AppTypography.titleLarge.copyWith(
          color: colors.onSurface,
        ),
      ),
      cardTheme: CardThemeData(
        color: colors.surface,
        elevation: 0,
        shape: const RoundedRectangleBorder(borderRadius: AppRadii.lgRadius),
        margin: EdgeInsets.zero,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: colors.brandPrimary,
          foregroundColor: colors.onBrandPrimary,
          shape: const RoundedRectangleBorder(borderRadius: AppRadii.mdRadius),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: colors.surfaceVariant,
        border: OutlineInputBorder(
          borderRadius: AppRadii.mdRadius,
          borderSide: BorderSide.none,
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: colors.surfaceVariant,
        labelStyle: AppTypography.labelLarge.copyWith(
          color: colors.onSurfaceVariant,
        ),
        shape: const StadiumBorder(),
      ),
    );
  }
}
