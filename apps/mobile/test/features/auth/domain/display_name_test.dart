import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/features/auth/domain/display_name.dart';
import 'package:flutter_test/flutter_test.dart';

MeResult _me(String name, {String phone = '+8801711000077'}) => MeResult(
  userId: 'u1',
  phone: phone,
  email: null,
  displayName: name,
  avatarStorageKey: null,
  tenantId: 't1',
  memberId: 'm1',
  role: 'member',
);

void main() {
  test("a new account's phone-digits name is a placeholder, shown empty", () {
    expect(hasPlaceholderName(_me('0077')), isTrue);
    expect(editableDisplayName(_me('0077')), '');
  });

  test('a real name is kept, even one ending in digits', () {
    expect(hasPlaceholderName(_me('রহিম')), isFalse);
    expect(editableDisplayName(_me('রহিম')), 'রহিম');
    expect(editableDisplayName(_me('Shop 0077')), 'Shop 0077');
  });
}
