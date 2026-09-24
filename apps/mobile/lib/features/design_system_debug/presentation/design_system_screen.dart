import 'package:flutter/material.dart';

import '../../../core/design/tokens/app_colors.dart';
import '../../../core/design/tokens/app_elevation.dart';
import '../../../core/design/tokens/app_radii.dart';
import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/tokens/app_typography.dart';
import '../../../core/design/widgets/app_bottom_sheet.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/app_chip.dart';
import '../../../core/design/widgets/app_text_field.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/design/widgets/loading_shimmer.dart';
import '../../../core/design/widgets/otp_code_input.dart';
import '../../../l10n/app_localizations.dart';

/// Internal QA screen — every design token and base widget in the current
/// theme, so a token/widget change is visible in one place. Debug builds
/// only: `AppRouter` doesn't register this route at all in release
/// (`kDebugMode` is a compile-time constant, so the branch is tree-shaken).
class DesignSystemScreen extends StatelessWidget {
  const DesignSystemScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.designSystemTitle)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          const _SectionTitle('Colors'),
          const _ColorSwatches(colors: AppColors.light, label: 'Light'),
          const SizedBox(height: AppSpacing.sm),
          const _ColorSwatches(colors: AppColors.dark, label: 'Dark'),

          const _SectionTitle('Spacing'),
          const _SpacingSamples(),

          const _SectionTitle('Radii'),
          const _RadiiSamples(),

          const _SectionTitle('Elevation'),
          const _ElevationSamples(),

          const _SectionTitle('Typography (বাংলা)'),
          const _TypeScaleSample(
            sampleText: 'আমার এলাকা — বাংলাদেশের হাইপারলোকাল প্ল্যাটফর্ম',
          ),
          const _SectionTitle('Typography (English)'),
          const _TypeScaleSample(
            sampleText: 'Amar Elaka — hyperlocal platform',
          ),

          const _SectionTitle('AppButton'),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: [
              AppButton(label: 'Primary', onPressed: () {}),
              AppButton(
                label: 'Secondary',
                variant: AppButtonVariant.secondary,
                onPressed: () {},
              ),
              AppButton(
                label: 'Text',
                variant: AppButtonVariant.text,
                onPressed: () {},
              ),
              AppButton(label: 'Loading', onPressed: () {}, isLoading: true),
              AppButton(label: 'Disabled', onPressed: null),
            ],
          ),

          const _SectionTitle('AppTextField'),
          const AppTextField(label: 'Label', hint: 'Hint text'),
          const SizedBox(height: AppSpacing.sm),
          const AppTextField(
            label: 'With error',
            errorText: 'This field is required',
          ),

          const _SectionTitle('AppCard'),
          AppCard(onTap: () {}, child: const Text('Tappable card')),

          const _SectionTitle('AppChip'),
          Wrap(
            spacing: AppSpacing.sm,
            children: [
              AppChip(label: 'Unselected', onSelected: (_) {}),
              AppChip(label: 'Selected', selected: true, onSelected: (_) {}),
            ],
          ),

          const _SectionTitle('AppBottomSheet'),
          AppButton(
            label: 'Show bottom sheet',
            variant: AppButtonVariant.secondary,
            onPressed: () => AppBottomSheet.show(
              context,
              builder: (context) => const Text('Sheet content'),
            ),
          ),

          const _SectionTitle('EmptyState'),
          const SizedBox(
            height: 160,
            child: EmptyState(
              title: 'Nothing here yet',
              message: 'A short message.',
            ),
          ),

          const _SectionTitle('ErrorState'),
          SizedBox(
            height: 160,
            child: ErrorState(
              title: 'Something went wrong',
              retryLabel: 'Retry',
              onRetry: () {},
            ),
          ),

          const _SectionTitle('LoadingShimmer'),
          const LoadingShimmer(height: 16, width: 200),
          const SizedBox(height: AppSpacing.xs),
          const LoadingShimmer(height: 64),

          const _SectionTitle('OtpCodeInput'),
          OtpCodeInput(length: 6, onCompleted: (_) {}),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
      child: Text(title, style: Theme.of(context).textTheme.headlineMedium),
    );
  }
}

class _ColorSwatches extends StatelessWidget {
  const _ColorSwatches({required this.colors, required this.label});

  final AppColorScheme colors;
  final String label;

  @override
  Widget build(BuildContext context) {
    final entries = <(String, Color)>[
      ('brandPrimary', colors.brandPrimary),
      ('brandSecondary', colors.brandSecondary),
      ('surface', colors.surface),
      ('surfaceVariant', colors.surfaceVariant),
      ('background', colors.background),
      ('outline', colors.outline),
      ('success', colors.success),
      ('warning', colors.warning),
      ('danger', colors.danger),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: AppSpacing.xs),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.sm,
          children: [
            for (final (name, color) in entries)
              Column(
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: AppRadii.smRadius,
                      border: Border.all(color: colors.outline),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(name, style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
          ],
        ),
      ],
    );
  }
}

class _SpacingSamples extends StatelessWidget {
  const _SpacingSamples();

  @override
  Widget build(BuildContext context) {
    const entries = <(String, double)>[
      ('xxs', AppSpacing.xxs),
      ('xs', AppSpacing.xs),
      ('sm', AppSpacing.sm),
      ('md', AppSpacing.md),
      ('lg', AppSpacing.lg),
      ('xl', AppSpacing.xl),
      ('xxl', AppSpacing.xxl),
      ('xxxl', AppSpacing.xxxl),
    ];
    final colorScheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (name, value) in entries)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.xxs),
            child: Row(
              children: [
                SizedBox(width: 48, child: Text(name)),
                Container(width: value, height: 12, color: colorScheme.primary),
              ],
            ),
          ),
      ],
    );
  }
}

class _RadiiSamples extends StatelessWidget {
  const _RadiiSamples();

  @override
  Widget build(BuildContext context) {
    const entries = <(String, double)>[
      ('sm', AppRadii.sm),
      ('md', AppRadii.md),
      ('lg', AppRadii.lg),
      ('xl', AppRadii.xl),
    ];
    final colorScheme = Theme.of(context).colorScheme;
    return Wrap(
      spacing: AppSpacing.sm,
      children: [
        for (final (name, value) in entries)
          Column(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(value),
                ),
              ),
              const SizedBox(height: AppSpacing.xxs),
              Text(name, style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
      ],
    );
  }
}

class _ElevationSamples extends StatelessWidget {
  const _ElevationSamples();

  @override
  Widget build(BuildContext context) {
    const entries = <(String, double)>[
      ('flat', AppElevation.flat),
      ('raised', AppElevation.raised),
      ('card', AppElevation.card),
      ('overlay', AppElevation.overlay),
      ('modal', AppElevation.modal),
    ];
    return Wrap(
      spacing: AppSpacing.md,
      runSpacing: AppSpacing.md,
      children: [
        for (final (name, value) in entries)
          Material(
            elevation: value,
            borderRadius: AppRadii.mdRadius,
            child: SizedBox(
              width: 72,
              height: 56,
              child: Center(child: Text(name)),
            ),
          ),
      ],
    );
  }
}

class _TypeScaleSample extends StatelessWidget {
  const _TypeScaleSample({required this.sampleText});

  final String sampleText;

  @override
  Widget build(BuildContext context) {
    final styles = <(String, TextStyle)>[
      ('displayLarge', AppTypography.displayLarge),
      ('headlineLarge', AppTypography.headlineLarge),
      ('titleLarge', AppTypography.titleLarge),
      ('bodyLarge', AppTypography.bodyLarge),
      ('labelLarge', AppTypography.labelLarge),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (name, style) in styles)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.xs),
            child: Text.rich(
              TextSpan(
                text: '$name  ',
                style: Theme.of(context).textTheme.bodySmall,
                children: [TextSpan(text: sampleText, style: style)],
              ),
              textHeightBehavior: AppTypography.heightBehavior,
            ),
          ),
      ],
    );
  }
}
