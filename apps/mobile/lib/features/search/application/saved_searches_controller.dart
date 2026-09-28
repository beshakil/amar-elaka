import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/saved_searches_api.dart';

/// The signed-in user's saved searches (ADR 041), with the new-result badge.
/// Pause/resume and delete update the list at once and roll back if the
/// server refuses; the error is rethrown for the screen to explain.
class SavedSearchesController extends AsyncNotifier<SavedSearchList> {
  SavedSearchesApi get _api => ref.read(savedSearchesApiProvider);

  @override
  Future<SavedSearchList> build() => _api.list();

  Future<void> setActive(String id, {required bool active}) async {
    final before = state.value;
    try {
      final updated = await _api.setActive(id, active: active);
      if (before != null) state = AsyncData(_replace(before, updated));
    } catch (_) {
      if (before != null) state = AsyncData(before);
      rethrow;
    }
    ref.invalidateSelf();
  }

  Future<void> delete(String id) async {
    final before = state.value;
    if (before != null) {
      state = AsyncData(
        SavedSearchList(
          items: [
            for (final s in before.items)
              if (s.id != id) s,
          ],
          newResultCount:
              before.newResultCount -
              (before.items
                      .where((s) => s.id == id)
                      .firstOrNull
                      ?.newResultCount ??
                  0),
          maxActive: before.maxActive,
          activeCount:
              before.activeCount -
              (before.items.any((s) => s.id == id && s.active) ? 1 : 0),
        ),
      );
    }
    try {
      await _api.delete(id);
    } catch (_) {
      if (before != null) state = AsyncData(before);
      rethrow;
    }
  }

  SavedSearchList _replace(SavedSearchList list, SavedSearch updated) =>
      SavedSearchList(
        items: [for (final s in list.items) s.id == updated.id ? updated : s],
        newResultCount: list.newResultCount,
        maxActive: list.maxActive,
        activeCount: list.items
            .map((s) => s.id == updated.id ? updated : s)
            .where((s) => s.active)
            .length,
      );
}

final savedSearchesProvider =
    AsyncNotifierProvider.autoDispose<SavedSearchesController, SavedSearchList>(
      SavedSearchesController.new,
    );

/// A saved search's new results; opening them marks them seen on the server.
final savedSearchNewResultsProvider = FutureProvider.autoDispose
    .family<SavedSearchNewResults, String>(
      (ref, id) => ref.watch(savedSearchesApiProvider).newResults(id),
    );
