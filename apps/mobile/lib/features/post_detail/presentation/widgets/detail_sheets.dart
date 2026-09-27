import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_bottom_sheet.dart';
import '../../../../core/design/widgets/app_button.dart';
import '../../../../l10n/app_localizations.dart';

/// report_reasons (apps/api/src/engagement/dto/engagement.dto.ts).
const reportReasons = [
  'scam',
  'fake_listing',
  'prohibited_item',
  'harassment',
  'spam',
  'wrong_information',
  'duplicate',
  'other',
];

String reportReasonLabel(String code, AppLocalizations l10n) => switch (code) {
  'scam' => l10n.detailReportScam,
  'fake_listing' => l10n.detailReportFakeListing,
  'prohibited_item' => l10n.detailReportProhibitedItem,
  'harassment' => l10n.detailReportHarassment,
  'spam' => l10n.detailReportSpam,
  'wrong_information' => l10n.detailReportWrongInformation,
  'duplicate' => l10n.detailReportDuplicate,
  _ => l10n.detailReportOther,
};

/// The report form: a reason, and optionally a few words.
abstract final class ReportSheet {
  static Future<({String reason, String text})?> show(BuildContext context) =>
      AppBottomSheet.show<({String reason, String text})>(
        context,
        isScrollControlled: true,
        builder: (_) => const _ReportBody(),
      );
}

class _ReportBody extends StatefulWidget {
  const _ReportBody();

  @override
  State<_ReportBody> createState() => _ReportBodyState();
}

class _ReportBodyState extends State<_ReportBody> {
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
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l10n.detailReportTitle,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            RadioGroup<String>(
              groupValue: _reason,
              onChanged: (value) => setState(() => _reason = value),
              child: Column(
                children: [
                  for (final code in reportReasons)
                    RadioListTile<String>(
                      key: ValueKey('report-$code'),
                      value: code,
                      title: Text(reportReasonLabel(code, l10n)),
                      contentPadding: EdgeInsets.zero,
                    ),
                ],
              ),
            ),
            TextField(
              controller: _text,
              maxLines: 3,
              decoration: InputDecoration(labelText: l10n.detailReportDetails),
            ),
            const SizedBox(height: AppSpacing.md),
            AppButton(
              key: const ValueKey('report-send'),
              label: l10n.detailReportSend,
              onPressed: _reason == null
                  ? null
                  : () => Navigator.of(
                      context,
                    ).pop((reason: _reason!, text: _text.text)),
            ),
          ],
        ),
      ),
    );
  }
}

/// What to do instead when WhatsApp isn't on the phone.
enum WhatsAppAlternative { web, sms, copy }

abstract final class WhatsAppMissingSheet {
  static Future<WhatsAppAlternative?> show(
    BuildContext context, {
    required ContactReveal reveal,
    required bool smsAllowed,
  }) => AppBottomSheet.show<WhatsAppAlternative>(
    context,
    builder: (context) {
      final l10n = AppLocalizations.of(context)!;
      void pick(WhatsAppAlternative choice) =>
          Navigator.of(context).pop(choice);
      return Column(
        key: const ValueKey('whatsapp-missing'),
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            l10n.detailWhatsappMissingTitle,
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(l10n.detailWhatsappMissingBody),
          const SizedBox(height: AppSpacing.sm),
          ListTile(
            leading: const Icon(Icons.open_in_browser),
            title: Text(l10n.detailWhatsappOpenWeb),
            onTap: () => pick(WhatsAppAlternative.web),
          ),
          if (smsAllowed)
            ListTile(
              leading: const Icon(Icons.sms_outlined),
              title: Text(l10n.detailSendSms),
              onTap: () => pick(WhatsAppAlternative.sms),
            ),
          ListTile(
            key: const ValueKey('whatsapp-missing-copy'),
            leading: const Icon(Icons.copy),
            title: Text(l10n.detailCopyNumber),
            onTap: () => pick(WhatsAppAlternative.copy),
          ),
        ],
      );
    },
  );
}
