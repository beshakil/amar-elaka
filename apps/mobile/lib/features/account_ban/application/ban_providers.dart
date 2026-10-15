import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/ban_api.dart';
import '../data/ban_models.dart';

/// The signed-in account's bans (empty when there are none).
final banNoticesProvider = FutureProvider.autoDispose<List<BanNotice>>(
  (ref) => ref.watch(banApiProvider).notices(),
);

final myComplaintsProvider = FutureProvider.autoDispose<List<MyComplaint>>(
  (ref) => ref.watch(banApiProvider).myComplaints(),
);
