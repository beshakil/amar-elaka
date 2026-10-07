import 'package:amar_elaka_app/core/dynamic_form/field_validator.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ValidationContext.now', () {
    // 20:30 UTC on 31 December: already 1 January at UTC+6.
    final at = DateTime.utc(2026, 12, 31, 20, 30);

    test("takes today from the tenant's offset (TenantConfig.timezone)", () {
      final context = ValidationContext.now(
        at: at,
        utcOffset: const Duration(hours: 6),
      );
      expect(context.today, '2027-01-01');
      expect(context.currentYear, 2027);

      final utc = ValidationContext.now(at: at, utcOffset: Duration.zero);
      expect(utc.today, '2026-12-31');
      expect(utc.currentYear, 2026);
    });

    test('without an offset, Bangladesh (UTC+6)', () {
      expect(ValidationContext.now(at: at).today, '2027-01-01');
    });
  });
}
