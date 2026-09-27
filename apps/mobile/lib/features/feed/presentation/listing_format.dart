import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../l10n/app_localizations.dart';

/// How a listing's price, distance and badges read, shared by the feed card
/// and the detail screen so both say the same thing.
abstract final class ListingFormat {
  // Presentation rule, not a business number: under a kilometre the
  // distance reads in metres, rounded to tens.
  static const _metresPerKm = 1000;
  static const _metreRounding = 10;

  /// "৳ ১৫,০০০", "৳ ৮,০০০/মাস", "ফ্রি", or "দাম জানতে যোগাযোগ করুন".
  static String price(
    String? price,
    String? priceType,
    AppLocalizations l10n,
    String locale, {
    bool free = false,
  }) {
    if (free || priceType == 'free') return l10n.feedBadgeFree;
    if (price == null) return l10n.postPriceOnRequest;
    final amount = '৳ ${formatMoney(price, locale)}';
    return priceType == 'per_month' ? '$amount${l10n.detailPerMonth}' : amount;
  }

  /// "৩৫০ মি দূরে", "১.২ কিমি দূরে"; null without a distance.
  static String? distance(
    double? metres,
    AppLocalizations l10n,
    String locale,
  ) {
    if (metres == null) return null;
    if (metres < _metresPerKm) {
      final rounded = ((metres / _metreRounding).round() * _metreRounding)
          .clamp(_metreRounding, _metresPerKm);
      return l10n.feedDistanceMeters(localizeDigits('$rounded', locale));
    }
    final km = (metres / _metresPerKm).toStringAsFixed(1);
    return l10n.feedDistanceKm(localizeDigits(km, locale));
  }

  /// The card badges the app shows, in order; unknown codes are skipped.
  static String? badge(String code, AppLocalizations l10n) => switch (code) {
    'boosted' => l10n.feedBadgeBoosted,
    'highlighted' => l10n.feedBadgeHighlighted,
    'verified_store' => l10n.feedBadgeVerifiedStore,
    'negotiable' => l10n.feedBadgeNegotiable,
    _ => null,
  };
}
