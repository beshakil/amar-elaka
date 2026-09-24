import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/design/app_theme.dart';
import 'core/design/theme_mode_controller.dart';
import 'core/design/tokens/app_typography.dart';
import 'core/design/widgets/offline_banner.dart';
import 'core/routing/app_router.dart';
import 'l10n/app_localizations.dart';

class App extends ConsumerWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    final themeMode = ref.watch(themeModeControllerProvider);

    return MaterialApp.router(
      onGenerateTitle: (context) => AppLocalizations.of(context)!.appTitle,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: themeMode,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      routerConfig: router,
      // Applies the Bengali-tuned line-height behavior (AppTypography) to
      // every Text widget app-wide, since Text resolves its
      // `textHeightBehavior` from the ambient DefaultTextStyle when it
      // doesn't set one itself. Also where the offline banner sits — over
      // every screen, not per-screen (`ErrorWidget.builder`, the "never a
      // raw exception" fallback, is set once in main.dart instead, since it
      // must be a static assignment made before the first frame, not
      // reassigned on every rebuild this callback runs on).
      builder: (context, child) {
        return DefaultTextStyle(
          style: AppTypography.bodyLarge,
          textHeightBehavior: AppTypography.heightBehavior,
          child: Column(
            children: [
              const OfflineBanner(),
              Expanded(child: child ?? const SizedBox.shrink()),
            ],
          ),
        );
      },
    );
  }
}
