import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/verification_api.dart';
import '../data/verification_models.dart';

/// The signed-in member's badge and identity requests.
final myVerificationsProvider = FutureProvider.autoDispose<MyVerifications>(
  (ref) => ref.watch(verificationApiProvider).mine(),
);

/// A store's verification, as its owner sees it.
final storeVerificationProvider = FutureProvider.autoDispose
    .family<StoreVerification, String>(
      (ref, storeId) => ref.watch(verificationApiProvider).store(storeId),
    );
