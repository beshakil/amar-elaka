import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../feed/application/feed_controller.dart';
import '../data/recent_searches_store.dart';
import '../data/search_api.dart';

/// As-you-type suggestions for [text] (empty until the server answers).
class SuggestState {
  const SuggestState({this.text = '', this.suggestions = SuggestResult.empty});

  final String text;
  final SuggestResult suggestions;
}

/// Suggestions as the viewer types (GET /search/suggest), debounced: one
/// request once typing pauses for [debounce], never one per keystroke, and
/// an answer for text that has since changed is dropped.
///
/// The text sent includes the word a Bengali keyboard is still composing
/// (Avro / Gboard phonetic keep a composing region over the whole word):
/// waiting for the composition to end would mean no suggestions at all.
class SuggestController extends Notifier<SuggestState> {
  /// Long enough to skip the keystrokes of a word, short enough to feel live.
  static const debounce = Duration(milliseconds: 250);

  Timer? _timer;

  @override
  SuggestState build() {
    ref.onDispose(() => _timer?.cancel());
    return const SuggestState();
  }

  void onChanged(String text) {
    _timer?.cancel();
    final trimmed = text.trim();
    state = SuggestState(
      text: trimmed,
      // Keep showing the last suggestions while they could still apply.
      suggestions: trimmed.isEmpty ? SuggestResult.empty : state.suggestions,
    );
    if (trimmed.isEmpty) return;
    _timer = Timer(debounce, () => _fetch(trimmed));
  }

  Future<void> _fetch(String text) async {
    try {
      final position = await ref.read(viewerPositionProvider.future);
      final result = await ref
          .read(searchApiProvider)
          .suggest(text, lat: position?.latitude, lng: position?.longitude);
      if (!ref.mounted || state.text != text) return;
      state = SuggestState(text: text, suggestions: result);
    } on AppException {
      // Suggestions are a convenience: typing and searching still work.
    }
  }
}

final suggestControllerProvider =
    NotifierProvider.autoDispose<SuggestController, SuggestState>(
      SuggestController.new,
    );

/// Trending chips: this area's top searches (GET /search/trending).
final trendingSearchesProvider = FutureProvider.autoDispose<List<String>>(
  (ref) async => (await ref.watch(searchApiProvider).trending()).queries,
);

/// The viewer's recent searches on this phone. Auto-disposed with the
/// suggestions panel, so every write checks it is still alive; a search
/// added elsewhere invalidates it.
class RecentSearchesController extends AsyncNotifier<List<String>> {
  @override
  Future<List<String>> build() => ref.watch(recentSearchesStoreProvider).read();

  Future<void> remove(String query) async {
    final next = await ref.read(recentSearchesStoreProvider).remove(query);
    if (ref.mounted) state = AsyncData(next);
  }

  Future<void> clear() async {
    await ref.read(recentSearchesStoreProvider).clear();
    if (ref.mounted) state = const AsyncData([]);
  }
}

final recentSearchesProvider =
    AsyncNotifierProvider.autoDispose<RecentSearchesController, List<String>>(
      RecentSearchesController.new,
    );
