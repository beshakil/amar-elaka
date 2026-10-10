import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/design/app_theme.dart';
import 'core/design/theme_mode_controller.dart';
import 'core/design/tokens/app_typography.dart';
import 'core/design/widgets/offline_banner.dart';
import 'core/l10n/locale_controller.dart';
import 'core/routing/app_router.dart';
import 'features/chat/application/chat_outbox.dart';
import 'features/notifications/presentation/push_rationale.dart';
import 'features/notifications/push/push_controller.dart';
import 'features/offline_map/application/offline_map_controller.dart';
import 'features/post/application/draft_sync.dart';
import 'l10n/app_localizations.dart';

class App extends ConsumerWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    final themeMode = ref.watch(themeModeControllerProvider);
    // Bengali unless the user chose English (Profile), whatever the phone's language.
    final locale = ref.watch(localeControllerProvider);
    // Posts submitted offline go out when the connection returns, whatever
    // screen is open (a provider nobody listens to is paused).
    ref.listen(draftSyncProvider, (_, _) {});
    // A newer downloaded map, looked for once per run (ADR 050).
    ref.listen(offlineMapAutoUpdateProvider, (_, _) {});
    // Push for the whole run: token, taps, foreground banners (ADR 060).
    ref.listen(pushControllerProvider, (_, _) {});
    // Chat messages written offline go out when they can, whatever screen is open.
    ref.listen(chatOutboxProvider, (_, _) {});

    return MaterialApp.router(
      onGenerateTitle: (context) => AppLocalizations.of(context)!.appTitle,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: themeMode,
      locale: locale,
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
          child: Stack(
            children: [
              Column(
                children: [
                  const OfflineBanner(),
                  Expanded(child: child ?? const SizedBox.shrink()),
                ],
              ),
              // A push that came while the app is open (ADR 060).
              const Positioned(
                top: 0,
                left: 0,
                right: 0,
                child: PushBannerOverlay(),
              ),
            ],
          ),
        );
      },
    );
  }
}
