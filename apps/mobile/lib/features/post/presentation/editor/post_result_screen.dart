import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_button.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../core/routing/route_paths.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../notifications/presentation/push_rationale.dart';
import '../../application/current_tenant.dart';

class PostResultArgs {
  const PostResultArgs({required this.post, required this.wasEdit});

  final PostView post;
  final bool wasEdit;
}

/// Step 7's outcome, said plainly: live now, or under review with how long
/// review usually takes here (moderation_typical_review_hours).
///
/// A first post (not an edit) is a meaningful moment to offer push (ADR 060):
/// buyers will message about it.
class PostResultScreen extends ConsumerStatefulWidget {
  const PostResultScreen({required this.args, super.key});

  final PostResultArgs args;

  @override
  ConsumerState<PostResultScreen> createState() => _PostResultScreenState();
}

class _PostResultScreenState extends ConsumerState<PostResultScreen> {
  PostResultArgs get args => widget.args;

  @override
  void initState() {
    super.initState();
    if (!args.wasEdit) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(offerPushAtMeaningfulMoment(context, ref));
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final hours =
        (ref.watch(currentTenantConfigProvider)?.moderation ??
                TenantModeration.fallback)
            .typicalReviewHours;
    final live = args.post.status == 'live';

    final (icon, title, message) = switch ((live, args.wasEdit)) {
      (true, false) => (
        Icons.check_circle_outline,
        l10n.postResultLiveTitle,
        l10n.postResultLiveMessage,
      ),
      (true, true) => (
        Icons.check_circle_outline,
        l10n.postResultSavedTitle,
        l10n.postResultLiveMessage,
      ),
      (false, _) => (
        Icons.hourglass_top_outlined,
        l10n.postResultPendingTitle,
        l10n.postResultPendingMessage(localizeDigits('$hours', locale)),
      ),
    };

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Icon(
                icon,
                size: 72,
                color: live
                    ? theme.colorScheme.primary
                    : theme.colorScheme.tertiary,
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                title,
                key: const ValueKey('result-title'),
                textAlign: TextAlign.center,
                style: theme.textTheme.headlineSmall,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                message,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyLarge,
              ),
              const SizedBox(height: AppSpacing.xl),
              AppButton(
                label: l10n.postResultViewMyPosts,
                onPressed: () => context.pushReplacement(RoutePaths.myPosts),
              ),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                label: l10n.postResultPostAnother,
                variant: AppButtonVariant.secondary,
                onPressed: () => context.go(RoutePaths.post),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
