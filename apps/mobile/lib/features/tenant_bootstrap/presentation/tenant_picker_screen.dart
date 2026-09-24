import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/app_text_field.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/design/widgets/loading_shimmer.dart';
import '../../../l10n/app_localizations.dart';
import '../application/tenant_bootstrap_controller.dart';
import '../domain/tenant_bootstrap_state.dart';
import '../domain/tenant_grouping.dart';

class TenantPickerScreen extends ConsumerStatefulWidget {
  const TenantPickerScreen({super.key});

  @override
  ConsumerState<TenantPickerScreen> createState() => _TenantPickerScreenState();
}

class _TenantPickerScreenState extends ConsumerState<TenantPickerScreen> {
  final _searchController = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final bootstrap = ref.watch(tenantBootstrapControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.tenantPickerTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            children: [
              AppTextField(
                label: l10n.tenantPickerSearchHint,
                controller: _searchController,
                prefixIcon: Icons.search,
                onChanged: (value) =>
                    setState(() => _query = value.trim().toLowerCase()),
              ),
              const SizedBox(height: AppSpacing.md),
              Expanded(
                child: switch (bootstrap) {
                  AsyncData(
                    value: TenantBootstrapNeedsSelection(:final tenants),
                  ) =>
                    _TenantGroupList(
                      groups: groupByDistrict(_filter(tenants, _query)),
                    ),
                  AsyncData() => const SizedBox.shrink(),
                  AsyncError() => ErrorState(
                    title: l10n.tenantPickerErrorTitle,
                    retryLabel: l10n.genericRetry,
                    onRetry: () => ref
                        .read(tenantBootstrapControllerProvider.notifier)
                        .retry(),
                  ),
                  _ => const _TenantListSkeleton(),
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  List<TenantSummary> _filter(List<TenantSummary> tenants, String query) {
    if (query.isEmpty) return tenants;
    return tenants
        .where(
          (t) =>
              t.nameBn.toLowerCase().contains(query) ||
              t.nameEn.toLowerCase().contains(query) ||
              t.slug.toLowerCase().contains(query) ||
              (t.districtNameBn?.toLowerCase().contains(query) ?? false) ||
              (t.districtNameEn?.toLowerCase().contains(query) ?? false),
        )
        .toList();
  }
}

class _TenantGroupList extends ConsumerWidget {
  const _TenantGroupList({required this.groups});

  final List<TenantDistrictGroup> groups;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    if (groups.isEmpty) {
      return EmptyState(
        title: l10n.tenantPickerEmptyTitle,
        icon: Icons.location_off_outlined,
      );
    }
    return ListView.builder(
      itemCount: groups.length,
      itemBuilder: (context, groupIndex) {
        final group = groups[groupIndex];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (group.districtName.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(
                  top: AppSpacing.md,
                  bottom: AppSpacing.xs,
                ),
                child: Text(
                  group.districtName,
                  style: Theme.of(context).textTheme.labelLarge,
                ),
              ),
            for (final tenant in group.tenants)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: AppCard(
                  onTap: () => ref
                      .read(tenantBootstrapControllerProvider.notifier)
                      .selectTenant(tenant.id),
                  child: Row(
                    children: [
                      Icon(
                        Icons.place_outlined,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              tenant.nameBn,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            Text(
                              tenant.nameEn,
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(
                                    color: Theme.of(
                                      context,
                                    ).colorScheme.onSurfaceVariant,
                                  ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _TenantListSkeleton extends StatelessWidget {
  const _TenantListSkeleton();

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      itemCount: 6,
      separatorBuilder: (context, index) =>
          const SizedBox(height: AppSpacing.sm),
      itemBuilder: (context, index) => const LoadingShimmer(height: 64),
    );
  }
}
