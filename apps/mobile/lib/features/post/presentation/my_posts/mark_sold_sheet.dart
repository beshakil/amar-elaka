import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_bottom_sheet.dart';
import '../../../../core/design/widgets/app_button.dart';
import '../../../../core/design/widgets/app_text_field.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';

/// Result of the "sold?" sheet: confirmed, with the sold price if given
/// (API money, "15000.00").
class MarkSoldChoice {
  const MarkSoldChoice(this.soldPrice);
  final String? soldPrice;
}

/// Asks to confirm "sold", with an optional sold price in either digit script.
Future<MarkSoldChoice?> showMarkSoldSheet(BuildContext context) =>
    AppBottomSheet.show<MarkSoldChoice>(
      context,
      isScrollControlled: true,
      builder: (sheet) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(sheet).bottom),
        child: const _MarkSoldForm(),
      ),
    );

class _MarkSoldForm extends StatefulWidget {
  const _MarkSoldForm();

  @override
  State<_MarkSoldForm> createState() => _MarkSoldFormState();
}

class _MarkSoldFormState extends State<_MarkSoldForm> {
  final _price = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _price.dispose();
    super.dispose();
  }

  void _confirm() {
    final typed = _price.text.trim();
    if (typed.isEmpty) {
      Navigator.of(context).pop(const MarkSoldChoice(null));
      return;
    }
    final money = parseMoneyInput(typed);
    if (money == null) {
      setState(
        () => _error = AppLocalizations.of(context)!.markSoldPriceInvalid,
      );
      return;
    }
    Navigator.of(context).pop(MarkSoldChoice(money));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(l10n.markSoldTitle, style: theme.textTheme.titleLarge),
        const SizedBox(height: AppSpacing.xs),
        Text(l10n.markSoldMessage, style: theme.textTheme.bodyMedium),
        const SizedBox(height: AppSpacing.md),
        AppTextField(
          key: const ValueKey('sold-price'),
          label: l10n.markSoldPriceLabel,
          helperText: l10n.markSoldPriceHint,
          prefixText: '৳ ',
          controller: _price,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          errorText: _error,
          onChanged: (_) {
            if (_error != null) setState(() => _error = null);
          },
        ),
        const SizedBox(height: AppSpacing.md),
        AppButton(
          key: const ValueKey('sold-confirm'),
          label: l10n.markSoldConfirm,
          onPressed: _confirm,
        ),
      ],
    );
  }
}
