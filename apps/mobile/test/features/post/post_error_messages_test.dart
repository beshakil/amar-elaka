import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/post/presentation/post_error_messages.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:amar_elaka_app/l10n/app_localizations_bn.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final AppLocalizations bn = AppLocalizationsBn();
  String say(AppException error) => describePostError(error, bn, 'bn');
  ApiException api(String code, {int status = 409, Object? details}) =>
      ApiException(
        ApiErrorBody(
          statusCode: status,
          error: code,
          message: 'English server text',
          details: details,
        ),
      );

  // Every code the post flows can get back (apps/api posts, media, categories, auth).
  const codes = [
    'POST_LIMIT_REACHED',
    'POST_TEXT_TOO_LONG',
    'FIELD_VALIDATION_FAILED',
    'POST_MEDIA_INVALID',
    'UPLOAD_MISSING',
    'UPLOAD_REJECTED',
    'POST_MEDIA_TENANT_MISMATCH',
    'POST_TOO_MANY_MEDIA',
    'UPLOAD_RATE_LIMITED',
    'CATEGORY_NOT_POSTABLE',
    'CATEGORY_NOT_FOUND',
    'POST_NOT_EDITABLE',
    'POST_ILLEGAL_TRANSITION',
    'POST_NOT_FOUND',
    'POST_NOT_OWNER',
    'POST_RENEW_TOO_EARLY',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENT_REQUEST_IN_PROGRESS',
    'LOCATION_NOT_FOUND',
    'UNAUTHENTICATED',
    'ACCOUNT_BANNED',
    'PERMISSION_DENIED',
    'TENANT_SUSPENDED',
    'VALIDATION_FAILED',
  ];

  test(
    'every known code gets its own Bengali sentence — never generic, never the API text',
    () {
      final generic = bn.postErrorUnknown('X').replaceAll('X', '');
      for (final code in codes) {
        final message = say(api(code));
        expect(message, isNot(contains('English server text')), reason: code);
        expect(message, isNot(contains(generic)), reason: code);
        expect(message, isNot(bn.errorGenericMessage), reason: code);
        expect(RegExp('[ঀ-৿]').hasMatch(message), isTrue, reason: code);
      }
    },
  );

  test(
    'uses the details: which limit, which field, the number in Bengali digits',
    () {
      expect(
        say(api('POST_LIMIT_REACHED', details: {'limit': 'daily', 'max': 10})),
        contains('১০'),
      );
      expect(
        say(api('POST_LIMIT_REACHED', details: {'limit': 'daily', 'max': 10})),
        contains('২৪ ঘণ্টায়'),
      );
      expect(
        say(api('POST_LIMIT_REACHED', details: {'limit': 'active', 'max': 20})),
        contains('সক্রিয়'),
      );
      expect(
        say(
          api(
            'POST_TEXT_TOO_LONG',
            details: {'field': 'description', 'max': 5000},
          ),
        ),
        startsWith('বিবরণ'),
      );
      expect(
        say(api('POST_TEXT_TOO_LONG', details: {'field': 'title', 'max': 120})),
        contains('১২০'),
      );
    },
  );

  test('a bad contact number points at the contact step', () {
    final error = ApiException(
      const ApiErrorBody(
        statusCode: 400,
        error: 'VALIDATION_FAILED',
        message: 'x',
        details: [
          {'path': 'contactPhone', 'message': 'a BD mobile number'},
        ],
      ),
    );
    expect(say(error), bn.postErrorContactPhone);
  });

  test('network and timeout say the work is saved', () {
    expect(say(const NetworkException()), contains('সংরক্ষিত'));
    expect(say(const TimeoutException()), contains('সংরক্ষিত'));
  });

  test(
    'an unknown code still names itself, and a 5xx says it is our fault',
    () {
      expect(say(api('SOMETHING_NEW', status: 400)), contains('SOMETHING_NEW'));
      expect(
        say(api('SOMETHING_NEW', status: 503)),
        contains('সার্ভারে সমস্যা'),
      );
    },
  );

  test('moderation reasons in words', () {
    expect(describeModerationReason('scam_suspected', bn), 'প্রতারণার সন্দেহ');
    expect(describeModerationReason('something_new', bn), bn.reasonOther);
  });
}
