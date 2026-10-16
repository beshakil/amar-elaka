import 'package:intl/intl.dart';

import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';

/// Words for the lookup codes the info services send (ADR 064); the API
/// sends codes, the app names them in its own strings (rule 6).
abstract final class InfoLabels {
  static String serviceType(String code, AppLocalizations l10n) =>
      switch (code) {
        'national_emergency' => l10n.emergencyTypeNationalEmergency,
        'police' => l10n.emergencyTypePolice,
        'fire_service' => l10n.emergencyTypeFireService,
        'hospital' => l10n.emergencyTypeHospital,
        'ambulance' => l10n.emergencyTypeAmbulance,
        'pharmacy_24h' => l10n.emergencyTypePharmacy24h,
        'electricity' => l10n.emergencyTypeElectricity,
        'gas' => l10n.emergencyTypeGas,
        'union_parishad' => l10n.emergencyTypeUnionParishad,
        'upazila_office' => l10n.emergencyTypeUpazilaOffice,
        'women_child_helpline' => l10n.emergencyTypeWomenChildHelpline,
        'health_helpline' => l10n.emergencyTypeHealthHelpline,
        'child_helpline' => l10n.emergencyTypeChildHelpline,
        'legal_aid' => l10n.emergencyTypeLegalAid,
        'disaster_warning' => l10n.emergencyTypeDisasterWarning,
        'information' => l10n.emergencyTypeInformation,
        'anti_corruption' => l10n.emergencyTypeAntiCorruption,
        _ => code,
      };

  static String commodityGroup(String code, AppLocalizations l10n) =>
      switch (code) {
        'rice_grains' => l10n.bazarGroupRiceGrains,
        'vegetables' => l10n.bazarGroupVegetables,
        'fish' => l10n.bazarGroupFish,
        'meat_eggs' => l10n.bazarGroupMeatEggs,
        'spices' => l10n.bazarGroupSpices,
        'oil' => l10n.bazarGroupOil,
        'pulses' => l10n.bazarGroupPulses,
        'fruits' => l10n.bazarGroupFruits,
        _ => code,
      };

  static String unit(String code, AppLocalizations l10n) => switch (code) {
    'kg' => l10n.feedUnitKg,
    'litre' => l10n.feedUnitLitre,
    'piece' => l10n.feedUnitPiece,
    'dozen' => l10n.feedUnitDozen,
    'hali' => l10n.feedUnitHali,
    'hundred' => l10n.feedUnitHundred,
    _ => code,
  };

  static String contactWindow(String code, AppLocalizations l10n) =>
      switch (code) {
        'morning' => l10n.bloodWindowMorning,
        'afternoon' => l10n.bloodWindowAfternoon,
        'evening' => l10n.bloodWindowEvening,
        'daytime' => l10n.bloodWindowDaytime,
        _ => l10n.bloodWindowAny,
      };

  static String urgency(String code, AppLocalizations l10n) => switch (code) {
    'critical' => l10n.bloodUrgencyCritical,
    'planned' => l10n.bloodUrgencyPlanned,
    _ => l10n.bloodUrgencyUrgent,
  };

  static String requestStatus(String code, AppLocalizations l10n) =>
      switch (code) {
        'fulfilled' => l10n.bloodStatusFulfilled,
        'cancelled' => l10n.bloodStatusCancelled,
        'expired' => l10n.bloodStatusExpired,
        'removed' => l10n.bloodStatusRemoved,
        _ => l10n.bloodStatusOpen,
      };

  /// "৳ ৫৮–৬২/কেজি": money in the locale's digits, never a float.
  static String priceRange(
    String min,
    String max,
    String unitCode,
    AppLocalizations l10n,
    String locale,
  ) {
    final range = min == max
        ? '৳ ${formatMoney(min, locale)}'
        : l10n.feedBazarRange(
            formatMoney(min, locale),
            formatMoney(max, locale),
          );
    return l10n.feedBazarPerUnit(range, unit(unitCode, l10n));
  }

  /// A YYYY-MM-DD day as "১৫ অক্টোবর".
  static String day(String isoDate, String locale) => localizeDigits(
    DateFormat.MMMMd(locale).format(DateTime.parse(isoDate)),
    locale,
  );

  /// A moment as "১৫ অক্টোবর, ৩:৩০ PM" in local time.
  static String moment(DateTime at, String locale) => localizeDigits(
    DateFormat.MMMMd(locale).add_jm().format(at.toLocal()),
    locale,
  );

  /// The `issues.reason` an API refusal carries (DONOR_CONTACT_REFUSED…).
  static String? refusalReason(Object error) {
    if (error is! ApiException) return null;
    final details = error.body.details;
    return details is Map ? details['reason'] as String? : null;
  }
}
