import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme_mode_controller.dart';
import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';

/// `AppShell` provides the shared app bar/bottom nav; this is body content only.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final session = ref.watch(authControllerProvider);
    final themeMode = ref.watch(themeModeControllerProvider);

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        switch (session) {
          AuthSessionAuthenticated(:final me) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ListTile(
                leading: const CircleAvatar(child: Icon(Icons.person_outline)),
                title: Text(me.displayName),
                subtitle: Text(me.phone),
                trailing: IconButton(
                  icon: const Icon(Icons.edit_outlined),
                  tooltip: l10n.profileEditButton,
                  onPressed: () => context.push(RoutePaths.profileCompletion),
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              AppButton(
                label: l10n.profileLogout,
                variant: AppButtonVariant.secondary,
                icon: Icons.logout,
                onPressed: () =>
                    ref.read(authControllerProvider.notifier).logout(),
              ),
            ],
          ),
          _ => Column(
            children: [
              Icon(
                Icons.account_circle_outlined,
                size: 64,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                l10n.profileGuestTitle,
                style: Theme.of(context).textTheme.titleMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.xs),
              Text(
                l10n.profileGuestMessage,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.md),
              AppButton(
                label: l10n.profileGuestLoginButton,
                onPressed: () => context.push(RoutePaths.login),
              ),
            ],
          ),
        },
        const SizedBox(height: AppSpacing.xl),
        Text(
          l10n.profileThemeLabel,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.sm),
        SegmentedButton<ThemeMode>(
          segments: [
            ButtonSegment(
              value: ThemeMode.light,
              label: Text(l10n.themeLight),
              icon: const Icon(Icons.light_mode_outlined),
            ),
            ButtonSegment(
              value: ThemeMode.dark,
              label: Text(l10n.themeDark),
              icon: const Icon(Icons.dark_mode_outlined),
            ),
            ButtonSegment(
              value: ThemeMode.system,
              label: Text(l10n.themeSystem),
              icon: const Icon(Icons.settings_suggest_outlined),
            ),
          ],
          selected: {themeMode},
          onSelectionChanged: (selection) {
            ref
                .read(themeModeControllerProvider.notifier)
                .setThemeMode(selection.first);
          },
        ),
        // Debug builds only (compile-time constant, tree-shaken in release):
        // the QA screens AppRouter registers under the same condition.
        if (kDebugMode) ...[
          const SizedBox(height: AppSpacing.xl),
          AppButton(
            label: l10n.designSystemTitle,
            variant: AppButtonVariant.text,
            icon: Icons.palette_outlined,
            onPressed: () => context.push(RoutePaths.designSystem),
          ),
          AppButton(
            label: l10n.formPreviewOpen,
            variant: AppButtonVariant.text,
            icon: Icons.dynamic_form_outlined,
            onPressed: () => context.push(RoutePaths.formPreview),
          ),
        ],
      ],
    );
  }
}
