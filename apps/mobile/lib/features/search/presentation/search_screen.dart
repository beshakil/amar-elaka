import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/routing/auth_gate.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../post/application/post_editor.dart';
import '../application/search_controller.dart';
import '../application/suggest_controller.dart';
import 'search_labels.dart';
import 'widgets/save_search_sheet.dart';
import 'widgets/search_field.dart';
import 'widgets/search_results_view.dart';
import 'widgets/suggestions_panel.dart';

/// Search (ADR 040): the bar on top; while it has focus (or nothing has been
/// searched yet) the suggestions — recent and trending, or as-you-type —
/// otherwise the results. Bengali, Banglish and English all work the same:
/// the matching happens on the server.
class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final _text = TextEditingController();
  final _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _focus.addListener(() => setState(() {}));
    // Opened to type: the keyboard comes up at once.
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Runs [q] (typed, a recent or trending search, a popular query).
  Future<void> _search(String q) async {
    if (q.trim().isEmpty) return;
    // Replacing the text here is the viewer's own choice, not mid-composition.
    if (_text.text != q) _text.text = q;
    _focus.unfocus();
    await ref.read(searchControllerProvider.notifier).submit(q);
    ref.invalidate(recentSearchesProvider);
  }

  Future<void> _openCategory(String slug) async {
    _text.clear();
    ref.read(suggestControllerProvider.notifier).onChanged('');
    _focus.unfocus();
    await ref.read(searchControllerProvider.notifier).openCategory(slug);
  }

  Future<void> _save(SearchLabels labels) async {
    if (!requireLogin(context, ref)) return;
    final state = ref.read(searchControllerProvider);
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final saved = await SaveSearchSheet.show(
      context,
      request: state.request,
      radiusKm: state.result?.radiusKm,
      labels: labels,
    );
    if (saved == null || !mounted) return;
    messenger.showSnackBar(
      SnackBar(
        key: const ValueKey('search-saved-snackbar'),
        content: Text(l10n.searchSaved),
        action: SnackBarAction(
          label: l10n.searchSavedView,
          onPressed: () => context.push(RoutePaths.savedSearches),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final submitted = ref.watch(
      searchControllerProvider.select((s) => s.submitted),
    );
    final labels = SearchLabels(
      l10n,
      locale,
      ref.watch(postableCategoriesProvider).value ?? const [],
    );
    final showSuggestions = _focus.hasFocus || !submitted;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: SearchField(
          controller: _text,
          focusNode: _focus,
          onChanged: ref.read(suggestControllerProvider.notifier).onChanged,
          onSubmitted: _search,
        ),
        actions: [
          IconButton(
            key: const ValueKey('search-open-saved'),
            tooltip: l10n.searchOpenSaved,
            icon: const Icon(Icons.bookmarks_outlined),
            onPressed: () {
              if (requireLogin(context, ref)) {
                context.push(RoutePaths.savedSearches);
              }
            },
          ),
        ],
      ),
      body: showSuggestions
          ? SuggestionsPanel(
              onQuery: _search,
              onCategory: _openCategory,
              onListing: (id) => context.push(RoutePaths.postDetailFor(id)),
            )
          : SearchResultsView(labels: labels, onSave: () => _save(labels)),
    );
  }
}
