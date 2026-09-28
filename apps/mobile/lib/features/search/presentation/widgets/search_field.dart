import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../l10n/app_localizations.dart';

/// The search bar. Written for Bengali keyboards (Gboard, Ridmik, Avro
/// phonetic) as much as Latin ones:
///
///  - plain `text` input with suggestions left on: some Android keyboards
///    drop to a Latin-only "password" layout when suggestions are off;
///  - no autocorrect, so a Banglish word ("basa vara") isn't "fixed" into
///    English;
///  - the text is never rewritten while the viewer types — only on their
///    own action (a suggestion, a recent search, clear) — so an IME's
///    composing region (a conjunct half-built, ক + ্ + ত) is never broken;
///  - the keyboard's action key searches.
///
/// Voice search is out of scope this month: its button is there, disabled,
/// so the layout won't shift when it arrives.
class SearchField extends StatelessWidget {
  const SearchField({
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.onSubmitted,
    super.key,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSubmitted;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return TextField(
      key: const ValueKey('search-field'),
      controller: controller,
      focusNode: focusNode,
      keyboardType: TextInputType.text,
      textInputAction: TextInputAction.search,
      textAlignVertical: TextAlignVertical.center,
      autocorrect: false,
      maxLength: 200,
      maxLengthEnforcement: MaxLengthEnforcement.enforced,
      onChanged: onChanged,
      onSubmitted: onSubmitted,
      decoration: InputDecoration(
        hintText: l10n.searchBarHint,
        counterText: '',
        border: InputBorder.none,
        prefixIcon: const Icon(Icons.search),
        suffixIcon: ValueListenableBuilder<TextEditingValue>(
          valueListenable: controller,
          builder: (context, value, _) => Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (value.text.isNotEmpty)
                IconButton(
                  key: const ValueKey('search-clear'),
                  tooltip: l10n.searchClearText,
                  icon: const Icon(Icons.close),
                  onPressed: () {
                    controller.clear();
                    onChanged('');
                    focusNode.requestFocus();
                  },
                ),
              IconButton(
                key: const ValueKey('search-voice'),
                tooltip: l10n.searchVoiceSoon,
                icon: const Icon(Icons.mic_none),
                onPressed: null,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
