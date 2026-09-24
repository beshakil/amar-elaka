import 'package:amar_elaka_app/features/auth/domain/bd_phone.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('isValidBdPhone', () {
    test('accepts the three input forms the backend accepts', () {
      expect(isValidBdPhone('01712345678'), isTrue);
      expect(isValidBdPhone('8801712345678'), isTrue);
      expect(isValidBdPhone('+8801712345678'), isTrue);
    });

    test('accepts the formatted display value (with the grouping dash)', () {
      expect(isValidBdPhone('01712-345678'), isTrue);
    });

    test('rejects an operator prefix outside 013–019', () {
      expect(isValidBdPhone('01212345678'), isFalse);
    });

    test('rejects the wrong length', () {
      expect(isValidBdPhone('0171234567'), isFalse);
      expect(isValidBdPhone('017123456789'), isFalse);
    });

    test('rejects non-numeric input', () {
      expect(isValidBdPhone('not a phone'), isFalse);
      expect(isValidBdPhone(''), isFalse);
    });
  });

  group('normalizeBdPhone', () {
    test('normalizes every accepted form to the same E.164 value', () {
      const expected = '+8801712345678';
      expect(normalizeBdPhone('01712345678'), expected);
      expect(normalizeBdPhone('8801712345678'), expected);
      expect(normalizeBdPhone('+8801712345678'), expected);
      expect(normalizeBdPhone('01712-345678'), expected);
    });

    test('returns null for an invalid number', () {
      expect(normalizeBdPhone('not a phone'), isNull);
    });
  });
}
