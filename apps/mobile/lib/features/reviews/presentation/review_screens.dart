import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';

import '../../../core/design/tokens/app_radii.dart';
import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/network_photo.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/routing/auth_gate.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../media_upload/data/image_compressor.dart';
import '../application/reviews_providers.dart';
import '../data/review_models.dart';
import '../data/reviews_api.dart';
import 'widgets/review_widgets.dart';

/// How many reviews the store page shows before "see all".
const _previewCount = 3;

/// The store page's reviews (ADR 061): the summary with the seller tier, the
/// newest few, and what the reader can do — write one (only after a real
/// contact, in the window: the screen says why not), edit theirs, or, for
/// the store's own people, reply.
class StoreReviewsSection extends ConsumerWidget {
  const StoreReviewsSection({required this.storeId, super.key});

  final String storeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final reviews = ref.watch(storeReviewsProvider(storeId));
    return Column(
      key: const ValueKey('store-reviews'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(l10n.reviewsTitle, style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        switch (reviews) {
          AsyncData(:final value) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ReviewSummaryCard(summary: value.summary),
              const SizedBox(height: AppSpacing.sm),
              _WriteReviewEntry(storeId: storeId),
              if (value.items.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
                  child: Text(l10n.reviewsNone),
                )
              else ...[
                for (final r in value.items.take(_previewCount))
                  ReviewCard(review: r),
                if (value.items.length > _previewCount || value.hasMore)
                  TextButton(
                    key: const ValueKey('reviews-see-all'),
                    onPressed: () => unawaited(
                      context.push(RoutePaths.storeReviewsFor(storeId)),
                    ),
                    child: Text(l10n.reviewsSeeAll),
                  ),
              ],
            ],
          ),
          AsyncError() => Text(l10n.reviewsLoadFailed),
          _ => const Padding(
            padding: EdgeInsets.all(AppSpacing.md),
            child: Center(child: CircularProgressIndicator()),
          ),
        },
      ],
    );
  }
}

/// "রিভিউ লিখুন" / "আপনার রিভিউ", or why the reader can't review yet.
class _WriteReviewEntry extends ConsumerWidget {
  const _WriteReviewEntry({required this.storeId});

  final String storeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final eligibility = ref.watch(reviewEligibilityProvider(storeId)).value;
    if (eligibility == null) return const SizedBox.shrink();
    void write() => unawaited(context.push(RoutePaths.writeReviewFor(storeId)));
    final note = switch (eligibility.status) {
      EligibilityStatus.noContact => l10n.reviewNoContact,
      EligibilityStatus.tooSoon when eligibility.eligibleAt != null =>
        l10n.reviewTooSoon(reviewDate(eligibility.eligibleAt!, locale)),
      EligibilityStatus.expired => l10n.reviewExpired,
      _ => null,
    };
    return switch (eligibility.status) {
      EligibilityStatus.eligible => FilledButton.tonalIcon(
        key: const ValueKey('review-write'),
        onPressed: write,
        icon: const Icon(Icons.rate_review_outlined),
        label: Text(l10n.reviewWrite),
      ),
      EligibilityStatus.alreadyReviewed => _MyReviewNote(
        storeId: storeId,
        review: eligibility.myReview,
      ),
      EligibilityStatus.signedOut => TextButton.icon(
        key: const ValueKey('review-sign-in'),
        onPressed: () => requireLogin(context, ref),
        icon: const Icon(Icons.login),
        label: Text(l10n.reviewSignIn),
      ),
      EligibilityStatus.ownStore ||
      EligibilityStatus.storeUnavailable => const SizedBox.shrink(),
      _ => Text(
        note ?? '',
        key: const ValueKey('review-not-eligible'),
        style: theme.textTheme.bodySmall,
      ),
    };
  }
}

class _MyReviewNote extends StatelessWidget {
  const _MyReviewNote({required this.storeId, required this.review});

  final String storeId;
  final MyReview? review;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final mine = review;
    if (mine == null) return const SizedBox.shrink();
    final note = switch (mine.status) {
      ReviewStatus.pending => l10n.reviewPendingNote,
      ReviewStatus.hidden || ReviewStatus.removed => l10n.reviewHiddenNote,
      ReviewStatus.published => null,
    };
    return Card(
      key: const ValueKey('review-mine'),
      margin: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Wrap(
                    spacing: AppSpacing.sm,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(l10n.reviewYours, style: theme.textTheme.labelLarge),
                      StarRating(rating: mine.rating, size: 16),
                    ],
                  ),
                ),
                if (mine.editableAt(DateTime.now()))
                  TextButton(
                    key: const ValueKey('review-edit'),
                    onPressed: () => unawaited(
                      context.push(RoutePaths.writeReviewFor(storeId)),
                    ),
                    child: Text(l10n.reviewEdit),
                  ),
              ],
            ),
            if (note != null) Text(note, style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

/// Every published review of a store, with replies; the store's people
/// reply from here, anyone else may report.
class StoreReviewsScreen extends ConsumerWidget {
  const StoreReviewsScreen({required this.storeId, super.key});

  final String storeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final reviews = ref.watch(storeReviewsProvider(storeId));
    final manages = ref.watch(managesStoreProvider(storeId)).value ?? false;
    final controller = ref.read(storeReviewsProvider(storeId).notifier);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.reviewsTitle)),
      body: switch (reviews) {
        AsyncData(:final value) => NotificationListener<ScrollEndNotification>(
          onNotification: (n) {
            if (n.metrics.extentAfter < AppSpacing.xxxl) {
              unawaited(controller.loadMore());
            }
            return false;
          },
          child: ListView(
            key: const ValueKey('store-reviews-list'),
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              ReviewSummaryCard(summary: value.summary),
              const SizedBox(height: AppSpacing.sm),
              _WriteReviewEntry(storeId: storeId),
              const Divider(),
              if (value.items.isEmpty) Text(l10n.reviewsNone),
              for (final r in value.items)
                ReviewCard(
                  review: r,
                  onReply: manages
                      ? () => unawaited(_reply(context, ref, r))
                      : null,
                  onReport: () => unawaited(_report(context, ref, r)),
                ),
              if (value.loadingMore)
                const Center(child: CircularProgressIndicator()),
              if (manages)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.md),
                  child: Text(
                    l10n.reviewOwnerCannotDelete,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
            ],
          ),
        ),
        AsyncError() => Center(
          child: TextButton(
            onPressed: () => ref.invalidate(storeReviewsProvider(storeId)),
            child: Text(l10n.reviewsLoadFailed),
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  Future<void> _reply(
    BuildContext context,
    WidgetRef ref,
    StoreReview review,
  ) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final text = await showDialog<String>(
      context: context,
      builder: (context) => _ReplyDialog(initial: review.response?.text ?? ''),
    );
    if (text == null || text.trim().isEmpty) return;
    try {
      await ref
          .read(storeReviewsProvider(storeId).notifier)
          .respond(review.id, text);
    } on Object {
      messenger.showSnackBar(SnackBar(content: Text(l10n.reviewReplyFailed)));
    }
  }

  Future<void> _report(
    BuildContext context,
    WidgetRef ref,
    StoreReview review,
  ) async {
    if (!requireLogin(context, ref)) return;
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final report = await showReviewReportSheet(context);
    if (report == null) return;
    try {
      await ref
          .read(reviewsApiProvider)
          .report(storeId, review.id, report.reasonCode, report.details);
      messenger.showSnackBar(SnackBar(content: Text(l10n.reviewReportSent)));
    } on Object {
      messenger.showSnackBar(SnackBar(content: Text(l10n.reviewFailed)));
    }
  }
}

class _ReplyDialog extends StatefulWidget {
  const _ReplyDialog({required this.initial});

  final String initial;

  @override
  State<_ReplyDialog> createState() => _ReplyDialogState();
}

class _ReplyDialogState extends State<_ReplyDialog> {
  late final _text = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return AlertDialog(
      title: Text(
        widget.initial.isEmpty ? l10n.reviewReply : l10n.reviewEditReply,
      ),
      content: TextField(
        key: const ValueKey('review-reply-input'),
        controller: _text,
        maxLines: 4,
        autofocus: true,
        decoration: InputDecoration(hintText: l10n.reviewReplyHint),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(l10n.reviewCancel),
        ),
        FilledButton(
          key: const ValueKey('review-reply-send'),
          onPressed: () => Navigator.pop(context, _text.text),
          child: Text(l10n.reviewReplySend),
        ),
      ],
    );
  }
}

/// Writing a review (or editing one's own, within review_edit_days): stars,
/// words, up to a few photos (compressed and uploaded into the store's
/// area). A review the integrity checks hold says so — it waits for a
/// moderator. Reached from the store page or a "how was it?" push.
class WriteReviewScreen extends ConsumerStatefulWidget {
  const WriteReviewScreen({
    required this.storeId,
    this.picker,
    this.compressor,
    super.key,
  });

  final String storeId;
  final ImagePicker? picker;
  final ImageCompressor? compressor;

  @override
  ConsumerState<WriteReviewScreen> createState() => _WriteReviewScreenState();
}

class _LocalPhoto {
  _LocalPhoto.picked(this.path) : uploaded = null;
  _LocalPhoto.existing(ReviewPhoto this.uploaded) : path = null;

  final String? path;
  final ReviewPhoto? uploaded;
}

class _WriteReviewScreenState extends ConsumerState<WriteReviewScreen> {
  final _text = TextEditingController();
  final _photos = <_LocalPhoto>[];
  int _rating = 0;
  bool _busy = false;
  bool _prefilled = false;

  /// Most photos on one review; the API's review_photos_max decides (this only stops the picker).
  static const _photosPickerCap = 3;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _prefill(MyReview? mine) {
    if (_prefilled || mine == null) return;
    _prefilled = true;
    _rating = mine.rating;
    _text.text = mine.text ?? '';
    _photos.addAll(mine.photos.map(_LocalPhoto.existing));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final eligibility = ref.watch(reviewEligibilityProvider(widget.storeId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.reviewWrite)),
      body: switch (eligibility) {
        AsyncData(:final value) => _body(context, l10n, locale, theme, value),
        AsyncError() => Center(child: Text(l10n.reviewsLoadFailed)),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  Widget _body(
    BuildContext context,
    AppLocalizations l10n,
    String locale,
    ThemeData theme,
    ReviewEligibility e,
  ) {
    final mine = e.myReview;
    final editing = e.status == EligibilityStatus.alreadyReviewed;
    if (editing) _prefill(mine);
    final blocked = switch (e.status) {
      EligibilityStatus.eligible => null,
      EligibilityStatus.alreadyReviewed
          when mine != null && mine.editableAt(DateTime.now()) =>
        null,
      EligibilityStatus.alreadyReviewed => l10n.reviewEditWindowOver,
      EligibilityStatus.noContact => l10n.reviewNoContact,
      EligibilityStatus.tooSoon when e.eligibleAt != null => l10n.reviewTooSoon(
        reviewDate(e.eligibleAt!, locale),
      ),
      EligibilityStatus.expired => l10n.reviewExpired,
      EligibilityStatus.ownStore => l10n.reviewOwnStore,
      EligibilityStatus.signedOut => l10n.reviewSignIn,
      _ => l10n.reviewFailed,
    };
    if (blocked != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Text(
            blocked,
            key: const ValueKey('review-blocked'),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyLarge,
          ),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Text(l10n.reviewRatingLabel, style: theme.textTheme.titleMedium),
        Center(
          child: StarRating(
            rating: _rating,
            size: 36,
            onChanged: (v) => setState(() => _rating = v),
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        TextField(
          key: const ValueKey('review-text'),
          controller: _text,
          minLines: 4,
          maxLines: 10,
          decoration: InputDecoration(
            hintText: l10n.reviewTextHint,
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.sm,
          children: [
            for (final (i, p) in _photos.indexed) _photoTile(l10n, i, p),
            if (_photos.length < _photosPickerCap)
              OutlinedButton.icon(
                key: const ValueKey('review-add-photo'),
                onPressed: _busy ? null : () => unawaited(_pick()),
                icon: const Icon(Icons.add_a_photo_outlined),
                label: Text(l10n.reviewAddPhoto),
              ),
          ],
        ),
        if (editing && mine != null) ...[
          const SizedBox(height: AppSpacing.sm),
          Text(
            l10n.reviewEditableUntil(reviewDate(mine.editableUntil, locale)),
            style: theme.textTheme.bodySmall,
          ),
        ],
        const SizedBox(height: AppSpacing.lg),
        FilledButton(
          key: const ValueKey('review-submit'),
          onPressed: _rating == 0 || _busy
              ? null
              : () => unawaited(_submit(editing)),
          child: _busy
              ? const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(editing ? l10n.reviewSave : l10n.reviewSubmit),
        ),
      ],
    );
  }

  Widget _photoTile(AppLocalizations l10n, int index, _LocalPhoto p) => Stack(
    children: [
      ClipRRect(
        borderRadius: AppRadii.mdRadius,
        child: SizedBox.square(
          dimension: 88,
          child: p.path != null
              ? Image.file(File(p.path!), fit: BoxFit.cover)
              : NetworkPhoto(
                  url: p.uploaded!.thumbUrl,
                  thumbhash: p.uploaded!.thumbhash,
                ),
        ),
      ),
      Positioned(
        top: 0,
        right: 0,
        child: IconButton.filledTonal(
          tooltip: l10n.reviewRemovePhoto,
          iconSize: 16,
          onPressed: () => setState(() => _photos.removeAt(index)),
          icon: const Icon(Icons.close),
        ),
      ),
    ],
  );

  Future<void> _pick() async {
    final picked = await (widget.picker ?? ImagePicker()).pickImage(
      source: ImageSource.gallery,
    );
    if (picked == null || !mounted) return;
    setState(() => _photos.add(_LocalPhoto.picked(picked.path)));
  }

  Future<String> _upload(String path) async {
    final dir = await getTemporaryDirectory();
    final target =
        '${dir.path}/review-${DateTime.now().microsecondsSinceEpoch}.webp';
    await (widget.compressor ?? PluginImageCompressor()).compress(path, target);
    final file = File(target);
    try {
      return await ref
          .read(reviewsApiProvider)
          .uploadImage(widget.storeId, file);
    } finally {
      if (file.existsSync()) unawaited(file.delete());
    }
  }

  Future<void> _submit(bool editing) async {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    setState(() => _busy = true);
    try {
      final photoIds = <String>[];
      for (final p in _photos) {
        try {
          photoIds.add(p.uploaded?.id ?? await _upload(p.path!));
        } on Object {
          messenger.showSnackBar(
            SnackBar(content: Text(l10n.reviewPhotoFailed)),
          );
          return;
        }
      }
      final api = ref.read(reviewsApiProvider);
      final result = editing
          ? await api.edit(
              widget.storeId,
              rating: _rating,
              text: _text.text,
              photoIds: photoIds,
            )
          : await api.submit(
              widget.storeId,
              rating: _rating,
              text: _text.text,
              photoIds: photoIds,
            );
      ref
        ..invalidate(storeReviewsProvider(widget.storeId))
        ..invalidate(reviewEligibilityProvider(widget.storeId));
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            result.needsReview
                ? l10n.reviewSubmittedPending
                : l10n.reviewSubmitted,
          ),
        ),
      );
      if (router.canPop()) router.pop();
    } on ApiException catch (e) {
      final max = e.body.details is Map
          ? (e.body.details! as Map)['max']
          : null;
      messenger.showSnackBar(
        SnackBar(
          content: Text(switch (e.code) {
            'REVIEW_TEXT_TOO_LONG' => l10n.reviewTextTooLong(
              localizeDigits('${max ?? ''}', locale),
            ),
            'REVIEW_EDIT_WINDOW_OVER' ||
            'REVIEW_DECIDED_BY_MODERATOR' => l10n.reviewEditWindowOver,
            'REVIEW_NOT_ELIGIBLE' => l10n.reviewNoContact,
            'REVIEW_PHOTOS_INVALID' => l10n.reviewPhotoFailed,
            _ => l10n.reviewFailed,
          }),
        ),
      );
      ref.invalidate(reviewEligibilityProvider(widget.storeId));
    } on Object {
      messenger.showSnackBar(SnackBar(content: Text(l10n.reviewFailed)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
