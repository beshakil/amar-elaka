import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../l10n/app_localizations.dart';

/// Why the user reports a conversation: a reason (CHAT_REPORT_REASONS in the
/// API) and optional words. Returns null when dismissed.
Future<({String reasonCode, String? text})?> showChatReportSheet(BuildContext context) =>
    showModalBottomSheet<({String reasonCode, String? text})>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => const _ReportSheet(),
    );

class _ReportSheet extends StatefulWidget {
  const _ReportSheet();

  @override
  State<_ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<_ReportSheet> {
  String? _reason;
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final reasons = {
      'scam': l10n.chatReportScam,
      'harassment': l10n.chatReportHarassment,
      'spam': l10n.chatReportSpam,
      'prohibited_item': l10n.chatReportProhibited,
      'other': l10n.chatReportOther,
    };
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        AppSpacing.md + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l10n.chatReportTitle, style: Theme.of(context).textTheme.titleMedium),
          RadioGroup<String>(
            groupValue: _reason,
            onChanged: (v) => setState(() => _reason = v),
            child: Column(
              children: [
                for (final entry in reasons.entries)
                  RadioListTile<String>(
                    key: ValueKey('chat-report-${entry.key}'),
                    value: entry.key,
                    title: Text(entry.value),
                  ),
              ],
            ),
          ),
          TextField(
            controller: _text,
            maxLines: 3,
            decoration: InputDecoration(hintText: l10n.chatReportDetailsHint, border: const OutlineInputBorder()),
          ),
          const SizedBox(height: AppSpacing.md),
          FilledButton(
            key: const ValueKey('chat-report-send'),
            onPressed: _reason == null
                ? null
                : () => Navigator.of(context).pop((reasonCode: _reason!, text: _text.text.trim().isEmpty ? null : _text.text.trim())),
            child: Text(l10n.chatReportSend),
          ),
        ],
      ),
    );
  }
}
