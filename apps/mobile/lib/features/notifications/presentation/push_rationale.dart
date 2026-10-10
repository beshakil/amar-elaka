import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../push/push_controller.dart';

/// A meaningful moment came — the user's first post went in, or their first
/// chat message left (ADR 060): show our explanation, once (then not for a
/// while after "এখন না"), never at first launch and never once Android's
/// own prompt was answered.
Future<void> offerPushAtMeaningfulMoment(
  BuildContext context,
  WidgetRef ref,
) async {
  final gate = ref.read(pushRationaleGateProvider);
  final router = GoRouter.of(context);
  if (!await gate.shouldOffer()) return;
  await gate.markShown();
  unawaited(router.push(RoutePaths.pushRationale));
}

/// Why we'd like to notify — in Bengali, before Android's system prompt.
class PushRationaleScreen extends ConsumerWidget {
  const PushRationaleScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Icon(
                Icons.notifications_active_outlined,
                size: AppSpacing.xxxl,
                color: theme.colorScheme.primary,
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                l10n.pushRationaleTitle,
                style: theme.textTheme.headlineSmall,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                l10n.pushRationaleBody,
                style: theme.textTheme.bodyLarge,
                textAlign: TextAlign.center,
              ),
              const Spacer(),
              FilledButton(
                key: const ValueKey('push-rationale-accept'),
                onPressed: () async {
                  final router = GoRouter.of(context);
                  await ref.read(pushRationaleGateProvider).accept();
                  router.pop();
                },
                child: Text(l10n.pushRationaleAccept),
              ),
              const SizedBox(height: AppSpacing.sm),
              TextButton(
                key: const ValueKey('push-rationale-not-now'),
                onPressed: () => context.pop(),
                child: Text(l10n.pushRationaleNotNow),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A push that came while the app was open, across the top of every screen.
class PushBannerOverlay extends ConsumerWidget {
  const PushBannerOverlay({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final payload = ref.watch(pushBannerProvider);
    if (payload == null) return const SizedBox.shrink();
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return SafeArea(
      bottom: false,
      child: Material(
        key: const ValueKey('push-banner'),
        elevation: 4,
        color: theme.colorScheme.secondaryContainer,
        child: ListTile(
          leading: const Icon(Icons.notifications_outlined),
          title: Text(
            payload.title ?? '',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: payload.body == null
              ? null
              : Text(
                  payload.body!,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
          trailing: TextButton(
            onPressed: () => ref.read(pushControllerProvider).openPush(payload),
            child: Text(l10n.pushBannerOpen),
          ),
          onTap: () => ref.read(pushControllerProvider).openPush(payload),
          onLongPress: () => ref.read(pushBannerProvider.notifier).dismiss(),
        ),
      ),
    );
  }
}
