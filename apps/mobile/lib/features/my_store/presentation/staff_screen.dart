import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';
import '../../store/data/store_api.dart';
import '../../store/data/store_models.dart';
import '../application/my_store_providers.dart';
import '../../auth/domain/bd_phone.dart';
import 'my_store_screen.dart' show roleLabel;
import 'store_messages.dart';

/// The store's staff (ADR 054/057): invite by phone number as a manager or
/// an editor, see who hasn't accepted yet, remove someone. Numbers show
/// masked; the invitee accepts in their own app.
class StaffScreen extends ConsumerWidget {
  const StaffScreen({required this.storeId, super.key});

  final String storeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final store = ref.watch(managedStoreProvider(storeId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.staffTitle)),
      body: switch (store) {
        AsyncData(:final value) => _StaffBody(store: value),
        AsyncError() => ErrorState(
          title: l10n.myStoreLoadFailed,
          retryLabel: l10n.storeRetry,
          onRetry: () => ref.invalidate(managedStoreProvider(storeId)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _StaffBody extends ConsumerStatefulWidget {
  const _StaffBody({required this.store});

  final ManagedStore store;

  @override
  ConsumerState<_StaffBody> createState() => _StaffBodyState();
}

class _StaffBodyState extends ConsumerState<_StaffBody> {
  final _phone = TextEditingController();
  String _role = 'editor';
  bool _sending = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  Future<void> _invite() async {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.of(context);
    final phone = normalizeBdPhone(toLatinDigits(_phone.text));
    if (phone == null) {
      setState(() => _error = l10n.storePhoneInvalid);
      return;
    }
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await ref.read(storeApiProvider).invite(widget.store.id, phone, _role);
      _phone.clear();
      ref.invalidate(managedStoreProvider(widget.store.id));
      messenger.showSnackBar(SnackBar(content: Text(l10n.staffInvited)));
    } on AppException catch (error) {
      if (mounted) {
        setState(() => _error = storeErrorMessage(error, l10n, locale));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _remove(StaffMember member) async {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.of(context);
    final name =
        member.displayName ?? localizeDigits(member.phoneMasked ?? '', locale);
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(l10n.staffRemoveConfirm(name)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.commonCancel),
          ),
          FilledButton(
            key: const ValueKey('staff-remove-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.staffRemove),
          ),
        ],
      ),
    );
    if (sure != true) return;
    try {
      await ref
          .read(storeApiProvider)
          .removeStaff(widget.store.id, member.memberId);
      ref.invalidate(managedStoreProvider(widget.store.id));
    } on AppException catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text(storeErrorMessage(error, l10n, locale))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final staff = widget.store.staff;
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        if (staff.isEmpty) Text(l10n.staffEmpty),
        for (final member in staff)
          ListTile(
            key: ValueKey('staff-${member.memberId}'),
            contentPadding: EdgeInsets.zero,
            leading: const CircleAvatar(child: Icon(Icons.person_outline)),
            title: Text(
              member.displayName ??
                  localizeDigits(member.phoneMasked ?? '', locale),
            ),
            subtitle: Text(
              [
                roleLabel(l10n, member.role),
                if (!member.accepted) l10n.staffPending,
              ].join(' · '),
            ),
            trailing: TextButton(
              onPressed: () => unawaited(_remove(member)),
              child: Text(l10n.staffRemove),
            ),
          ),
        const Divider(height: AppSpacing.xl),
        Text(l10n.staffInvite, style: theme.textTheme.titleMedium),
        Text(
          l10n.staffLimit(localizeDigits('${widget.store.staffLimit}', locale)),
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          key: const ValueKey('staff-phone'),
          controller: _phone,
          keyboardType: TextInputType.phone,
          decoration: InputDecoration(labelText: l10n.staffPhone),
        ),
        RadioGroup<String>(
          groupValue: _role,
          onChanged: (role) => setState(() => _role = role ?? 'editor'),
          child: Column(
            children: [
              RadioListTile<String>(
                key: const ValueKey('staff-role-editor'),
                value: 'editor',
                title: Text(l10n.staffRoleEditor),
              ),
              RadioListTile<String>(
                key: const ValueKey('staff-role-manager'),
                value: 'manager',
                title: Text(l10n.staffRoleManager),
              ),
            ],
          ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: Text(
              _error!,
              style: TextStyle(color: theme.colorScheme.error),
            ),
          ),
        AppButton(
          key: const ValueKey('staff-send'),
          label: l10n.staffSendInvite,
          isLoading: _sending,
          onPressed: _sending ? null : () => unawaited(_invite()),
        ),
      ],
    );
  }
}
