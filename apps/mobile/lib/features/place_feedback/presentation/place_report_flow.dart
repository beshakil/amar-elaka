import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/map/location_picker.dart' show GeoPoint;
import '../../../core/network/api_exception.dart';
import '../../../core/routing/auth_gate.dart';
import '../../../l10n/app_localizations.dart';
import '../data/place_feedback_api.dart';
import 'place_feedback_messages.dart';
import 'place_report_sheet.dart';

/// "সমস্যা জানান" for a place, from any screen (ADR 051): sign in first,
/// pick a reason in the sheet, send it; the answer never says more than
/// "sent".
Future<void> reportPlace(
  BuildContext context,
  WidgetRef ref, {
  required String placeId,
  required GeoPoint location,
}) async {
  if (!requireLogin(context, ref)) return;
  final l10n = AppLocalizations.of(context)!;
  final locale = Localizations.localeOf(context).languageCode;
  final messenger = ScaffoldMessenger.of(context);
  final picked = await PlaceReportSheet.show(
    context,
    placeId: placeId,
    location: location,
  );
  if (picked == null || !context.mounted) return;
  try {
    await ref
        .read(placeFeedbackApiProvider)
        .report(
          placeId,
          picked.reason,
          picked.text,
          duplicateOf: picked.duplicateOf,
        );
    messenger.showSnackBar(SnackBar(content: Text(l10n.placeReportSent)));
  } on AppException catch (error) {
    messenger.showSnackBar(
      SnackBar(content: Text(placeFeedbackError(error, l10n, locale))),
    );
  }
}
