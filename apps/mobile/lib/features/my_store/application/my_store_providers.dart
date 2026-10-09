import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../store/data/store_api.dart';
import '../../store/data/store_models.dart';

/// The stores the signed-in member owns, staffs or is invited to.
final myStoresProvider = FutureProvider.autoDispose<List<MyStoreSummary>>(
  (ref) => ref.watch(storeApiProvider).mine(),
);

/// One store as its people see it (numbers, staff, catalog link).
final managedStoreProvider = FutureProvider.autoDispose
    .family<ManagedStore, String>(
      (ref, storeId) => ref.watch(storeApiProvider).manage(storeId),
    );

/// A store's hours as saved (weekly, holidays, closed today).
final storeHoursProvider = FutureProvider.autoDispose
    .family<StoreHours, String>(
      (ref, storeId) => ref.watch(storeApiProvider).hours(storeId),
    );

class StockState {
  const StockState({
    required this.items,
    required this.nextCursor,
    this.saving = const {},
  });

  final List<StoreProduct> items;
  final String? nextCursor;

  /// Products whose new stock is on its way.
  final Set<String> saving;

  StockState copyWith({
    List<StoreProduct>? items,
    String? nextCursor,
    bool clearCursor = false,
    Set<String>? saving,
  }) => StockState(
    items: items ?? this.items,
    nextCursor: clearCursor ? null : nextCursor ?? this.nextCursor,
    saving: saving ?? this.saving,
  );
}

/// The store's products with their stock (ADR 057), changed one tap at a time.
class StockController extends AsyncNotifier<StockState> {
  StockController(this.storeId);

  final String storeId;

  @override
  Future<StockState> build() async {
    final page = await ref.watch(storeApiProvider).products(storeId);
    return StockState(items: page.items, nextCursor: page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current?.nextCursor == null) return;
    final page = await ref
        .read(storeApiProvider)
        .products(storeId, cursor: current!.nextCursor);
    if (!ref.mounted) return;
    state = AsyncData(
      current.copyWith(
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
        clearCursor: page.nextCursor == null,
      ),
    );
  }

  /// At once on screen; back if the server says no (rethrown).
  Future<void> setStock(String postId, String stock) async {
    final current = state.value;
    if (current == null) return;
    StockState mark(
      StockState s,
      String value, {
      required bool saving,
    }) => s.copyWith(
      items: [for (final p in s.items) p.id == postId ? p.withStock(value) : p],
      saving: saving ? {...s.saving, postId} : ({...s.saving}..remove(postId)),
    );
    final before = current.items.firstWhere((p) => p.id == postId).stockStatus;
    state = AsyncData(mark(current, stock, saving: true));
    try {
      await ref.read(storeApiProvider).setStock(postId, stock);
      if (ref.mounted) {
        state = AsyncData(mark(state.value!, stock, saving: false));
      }
    } on AppException {
      if (ref.mounted) {
        state = AsyncData(mark(state.value!, before, saving: false));
      }
      rethrow;
    }
  }
}

final stockProvider = AsyncNotifierProvider.autoDispose
    .family<StockController, StockState, String>(StockController.new);
