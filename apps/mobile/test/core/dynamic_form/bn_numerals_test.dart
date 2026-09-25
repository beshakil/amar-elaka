import 'package:amar_elaka_app/core/dynamic_form/bn_numerals.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('converts digits both ways', () {
    expect(toBengaliDigits('Flat 12, floor 3'), 'Flat ১২, floor ৩');
    expect(toLatinDigits('১২৩abc৪৫'), '123abc45');
  });

  test('groups lakh/crore style', () {
    expect(
      [
        '1',
        '123',
        '1234',
        '123456',
        '1234567',
        '1234567890',
      ].map(groupSouthAsian),
      ['1', '123', '1,234', '1,23,456', '12,34,567', '1,23,45,67,890'],
    );
  });

  test('formats money in Bengali, keeping paisa only when non-zero', () {
    expect(formatMoney('1234567.00', 'bn'), '১২,৩৪,৫৬৭');
    expect(formatMoney('15000.50', 'bn'), '১৫,০০০.৫০');
    expect(formatMoney('1234567.00', 'en'), '12,34,567');
    expect(formatMoney('0.00', 'bn'), '০');
  });

  test('formats plain numbers without grouping', () {
    expect(formatNumber(2019, 'bn'), '২০১৯');
    expect(formatNumber(2.5, 'bn'), '২.৫');
  });

  test('parses money and numbers typed in either script', () {
    expect(parseMoneyInput('১৫,০০০'), '15000.00');
    expect(parseMoneyInput('৳ 1,50,000.5'), '150000.50');
    expect(parseMoneyInput('15000.555'), isNull);
    expect(parseMoneyInput('1e5'), isNull);
    expect(parseNumberInput('৩'), 3);
    expect(parseNumberInput('-২'), -2);
    expect(parseNumberInput('2.5'), 2.5);
    expect(parseNumberInput('abc'), isNull);
  });

  test('normalises Bangladeshi phone numbers to E.164', () {
    expect(normalizePhoneInput('০১৭১১-০০০০০০'), '+8801711000000');
    expect(normalizePhoneInput('+880 1711 000000'), '+8801711000000');
    expect(normalizePhoneInput('12345'), '12345');
  });
}
