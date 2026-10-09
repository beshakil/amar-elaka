import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_form_controls.dart';
import '../../../../core/design/widgets/app_text_field.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../auth/domain/bd_phone.dart';
import '../../../my_store/application/my_store_providers.dart';
import '../../../store/data/store_models.dart';
import '../../application/post_editor.dart';
import 'step_gate.dart';

/// Step 5: how buyers reach the seller — name and number from the profile
/// (editable for this post), and whether to show the number, take chat
/// messages, and take WhatsApp on that number.
class ContactStep extends StatefulWidget {
  const ContactStep({required this.editor, required this.gate, super.key});

  final PostEditor editor;
  final StepGate gate;

  @override
  State<ContactStep> createState() => _ContactStepState();
}

class _ContactStepState extends State<ContactStep> {
  late final TextEditingController _name = TextEditingController(
    text: widget.editor.draft!.contactName,
  );
  late final TextEditingController _phone = TextEditingController(
    text: _localPhone(widget.editor.draft!.contactPhone),
  );
  bool _checked = false;

  /// +8801712345678 → ০১৭১২৩৪৫৬৭৮ (what a Bangladeshi types and reads).
  String _localPhone(String e164) => e164.isEmpty
      ? ''
      : toBengaliDigits(e164.replaceFirst(RegExp(r'^\+88'), ''));

  @override
  void initState() {
    super.initState();
    widget.gate.register(_check);
  }

  @override
  void dispose() {
    widget.gate.unregister(_check);
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  String? _nameError(AppLocalizations l10n) =>
      _checked && _name.text.trim().isEmpty
      ? l10n.postContactNameRequired
      : null;

  String? _phoneError(AppLocalizations l10n) {
    if (!_checked) return null;
    final draft = widget.editor.draft!;
    final typed = _phone.text.trim();
    if (typed.isEmpty && !draft.showPhone) return null;
    return isValidBdPhone(toLatinDigits(typed))
        ? null
        : l10n.postContactPhoneInvalid;
  }

  bool get _reachable =>
      widget.editor.draft!.showPhone || widget.editor.draft!.allowChat;

  bool _check() {
    final l10n = AppLocalizations.of(context)!;
    setState(() => _checked = true);
    return _nameError(l10n) == null && _phoneError(l10n) == null && _reachable;
  }

  void _onPhoneChanged(String value) {
    final e164 = normalizeBdPhone(toLatinDigits(value));
    widget.editor.update((d) => d.copyWith(contactPhone: e164 ?? ''));
    if (_checked) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return ListenableBuilder(
      listenable: widget.editor,
      builder: (context, _) {
        final draft = widget.editor.draft!;
        return ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            if (!draft.isEdit) _PostAs(editor: widget.editor),
            Text(l10n.postContactFromProfile, style: theme.textTheme.bodySmall),
            const SizedBox(height: AppSpacing.md),
            AppTextField(
              key: const ValueKey('contact-name'),
              label: l10n.postContactNameLabel,
              controller: _name,
              requiredLabel: l10n.dynamicFormRequired,
              errorText: _nameError(l10n),
              autofillHints: const [AutofillHints.name],
              textInputAction: TextInputAction.next,
              onChanged: (value) {
                widget.editor.update((d) => d.copyWith(contactName: value));
                if (_checked) setState(() {});
              },
            ),
            const SizedBox(height: AppSpacing.md),
            AppTextField(
              key: const ValueKey('contact-phone'),
              label: l10n.postContactPhoneLabel,
              controller: _phone,
              keyboardType: TextInputType.phone,
              hint: '০১XXXXXXXXX',
              errorText: _phoneError(l10n),
              autofillHints: const [AutofillHints.telephoneNumberNational],
              onChanged: _onPhoneChanged,
            ),
            const SizedBox(height: AppSpacing.md),
            AppSwitchTile(
              key: const ValueKey('contact-show-phone'),
              label: l10n.postContactShowPhone,
              value: draft.showPhone,
              onChanged: (on) => widget.editor.update(
                (d) => d.copyWith(
                  showPhone: on,
                  showWhatsapp: on && d.showWhatsapp,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(left: AppSpacing.md),
              child: Text(
                l10n.postContactShowPhoneHint,
                style: theme.textTheme.bodySmall,
              ),
            ),
            AppSwitchTile(
              key: const ValueKey('contact-whatsapp'),
              label: l10n.postContactWhatsapp,
              value: draft.showWhatsapp,
              onChanged: draft.showPhone
                  ? (on) => widget.editor.update(
                      (d) => d.copyWith(showWhatsapp: on),
                    )
                  : null,
            ),
            if (!draft.showPhone)
              Padding(
                padding: const EdgeInsets.only(left: AppSpacing.md),
                child: Text(
                  l10n.postContactWhatsappNeedsPhone,
                  style: theme.textTheme.bodySmall,
                ),
              ),
            AppSwitchTile(
              key: const ValueKey('contact-chat'),
              label: l10n.postContactAllowChat,
              value: draft.allowChat,
              onChanged: (on) =>
                  widget.editor.update((d) => d.copyWith(allowChat: on)),
            ),
            if (_checked && !_reachable)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.sm),
                child: Text(
                  l10n.postContactNoWay,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// "কার নামে পোস্ট করবেন" (ADR 057): personally, or as one of the seller's
/// active stores — shown only to someone who runs or staffs one.
class _PostAs extends ConsumerWidget {
  const _PostAs({required this.editor});

  final PostEditor editor;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final stores = [
      for (final s
          in ref.watch(myStoresProvider).value ?? const <MyStoreSummary>[])
        if (s.accepted && s.status == 'active') s,
    ];
    if (stores.isEmpty) return const SizedBox.shrink();
    final current = editor.draft!.storeId;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l10n.postAsTitle, style: Theme.of(context).textTheme.titleSmall),
          RadioGroup<String>(
            groupValue: current ?? '',
            onChanged: (id) => editor.update(
              (d) => id == null || id.isEmpty
                  ? d.copyWith(clearStore: true)
                  : d.copyWith(storeId: id),
            ),
            child: Column(
              children: [
                RadioListTile<String>(
                  key: const ValueKey('post-as-personal'),
                  value: '',
                  title: Text(l10n.postAsPersonal),
                ),
                for (final s in stores)
                  RadioListTile<String>(
                    key: ValueKey('post-as-${s.slug}'),
                    value: s.id,
                    secondary: const Icon(Icons.storefront_outlined),
                    title: Text(s.name.of(locale, fallback: s.slug)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
