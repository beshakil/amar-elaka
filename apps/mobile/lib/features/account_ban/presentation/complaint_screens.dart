import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';
import '../application/ban_providers.dart';
import '../data/ban_api.dart';
import '../data/ban_models.dart';

/// "অভিযোগ করুন" (ADR 063): a complaint about a person or a store — not a
/// report on one post. It goes to the subject's area, whose moderators work
/// it. [postId]: the post the person was seen on (it decides the area).
Future<void> showComplaintSheet(
  BuildContext context, {
  required String subjectType,
  String? subjectId,
  required String subjectName,
  String? postId,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: ComplaintSheet(
      subjectType: subjectType,
      subjectId: subjectId,
      subjectName: subjectName,
      postId: postId,
    ),
  ),
);

class ComplaintSheet extends ConsumerStatefulWidget {
  const ComplaintSheet({
    required this.subjectType,
    required this.subjectName,
    this.subjectId,
    this.postId,
    super.key,
  });

  final String subjectType;

  /// Null for "the person on this post" ([postId]): the API resolves them.
  final String? subjectId;
  final String subjectName;
  final String? postId;

  @override
  ConsumerState<ComplaintSheet> createState() => _ComplaintSheetState();
}

class _ComplaintSheetState extends ConsumerState<ComplaintSheet> {
  final _description = TextEditingController();
  ComplaintCategory? _category;
  bool _busy = false;

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return SafeArea(
      child: SingleChildScrollView(
        key: const ValueKey('complaint-sheet'),
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              l10n.complaintTitle(widget.subjectName),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              l10n.complaintIntro,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: AppSpacing.sm),
            RadioGroup<ComplaintCategory>(
              groupValue: _category,
              onChanged: (value) => setState(() => _category = value),
              child: Column(
                children: [
                  for (final c in ComplaintCategory.values)
                    RadioListTile<ComplaintCategory>(
                      key: ValueKey('complaint-${complaintCategoryCode(c)}'),
                      value: c,
                      title: Text(complaintCategoryLabel(l10n, c)),
                      dense: true,
                    ),
                ],
              ),
            ),
            TextField(
              key: const ValueKey('complaint-description'),
              controller: _description,
              minLines: 3,
              maxLines: 6,
              decoration: InputDecoration(
                labelText: l10n.complaintDescriptionLabel,
                hintText: l10n.complaintDescriptionHint,
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: AppSpacing.md),
            AppButton(
              key: const ValueKey('complaint-submit'),
              label: l10n.complaintSubmit,
              isLoading: _busy,
              onPressed: _category == null || _description.text.trim().isEmpty
                  ? null
                  : () => unawaited(_submit()),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    setState(() => _busy = true);
    try {
      final reference = await ref
          .read(banApiProvider)
          .complain(
            subjectType: widget.subjectType,
            subjectId: widget.subjectId,
            category: _category!,
            description: _description.text.trim(),
            postId: widget.postId,
          );
      ref.invalidate(myComplaintsProvider);
      navigator.pop();
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.complaintSent(reference))),
      );
    } on Object catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(complaintErrorMessage(l10n, e))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

String complaintCategoryLabel(AppLocalizations l10n, ComplaintCategory c) =>
    switch (c) {
      ComplaintCategory.fakeSeller => l10n.complaintFakeSeller,
      ComplaintCategory.scam => l10n.complaintScam,
      ComplaintCategory.abuse => l10n.complaintAbuse,
      ComplaintCategory.other => l10n.complaintOther,
    };

String complaintErrorMessage(AppLocalizations l10n, Object error) {
  if (error is! ApiException) return l10n.complaintFailed;
  final details = error.body.details;
  final reason = details is Map ? details['reason'] : null;
  return switch ((error.code, reason)) {
    ('COMPLAINT_NOT_ALLOWED', 'open_complaint') => l10n.complaintAlreadyOpen,
    ('COMPLAINT_NOT_ALLOWED', 'rate_limited') => l10n.complaintRateLimited,
    ('COMPLAINT_NOT_ALLOWED', 'self') => l10n.complaintSelf,
    _ => l10n.complaintFailed,
  };
}

/// "আমার অভিযোগ": what one filed and where each stands.
class MyComplaintsScreen extends ConsumerWidget {
  const MyComplaintsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final complaints = ref.watch(myComplaintsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.myComplaintsTitle)),
      body: switch (complaints) {
        AsyncData(:final value) when value.isEmpty => Center(
          child: Text(l10n.myComplaintsNone),
        ),
        AsyncData(:final value) => ListView(
          key: const ValueKey('my-complaints'),
          children: [
            for (final c in value)
              ListTile(
                key: ValueKey('my-complaint-${c.reference}'),
                title: Text(
                  c.subjectName ?? complaintCategoryLabel(l10n, c.category),
                ),
                subtitle: Text(
                  '${complaintCategoryLabel(l10n, c.category)} · ${c.reference} · '
                  '${localizeDigits(DateFormat.yMMMd(locale).format(c.createdAt.toLocal()), locale)}',
                ),
                trailing: Text(
                  c.resolved
                      ? l10n.complaintResolved
                      : c.inProgress
                      ? l10n.complaintInProgress
                      : l10n.complaintPending,
                ),
              ),
          ],
        ),
        AsyncError() => Center(
          child: TextButton(
            onPressed: () => ref.invalidate(myComplaintsProvider),
            child: Text(l10n.banLoadFailed),
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}
