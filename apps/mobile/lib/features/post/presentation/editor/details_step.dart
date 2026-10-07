import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_text_field.dart';
import '../../../../core/dynamic_form/dynamic_form.dart';
import '../../../../core/dynamic_form/field_validator.dart';
import '../../../../l10n/app_localizations.dart';
import '../../application/current_tenant.dart';
import '../../application/post_editor.dart';
import 'step_gate.dart';

/// Step 2: title, description, and the category's own fields (price, rooms,
/// model…) from its field schema — the Month 1 dynamic form, driven from
/// the stepper. Every keystroke is saved to the draft as typed.
class DetailsStep extends ConsumerStatefulWidget {
  const DetailsStep({required this.editor, required this.gate, super.key});

  final PostEditor editor;
  final StepGate gate;

  @override
  ConsumerState<DetailsStep> createState() => _DetailsStepState();
}

class _DetailsStepState extends ConsumerState<DetailsStep> {
  final _form = DynamicFormController();
  late final TextEditingController _title = TextEditingController(
    text: widget.editor.draft!.title,
  );
  late final TextEditingController _description = TextEditingController(
    text: widget.editor.draft!.description,
  );
  final _titleFocus = FocusNode();
  bool _showTitleError = false;

  @override
  void initState() {
    super.initState();
    widget.gate.register(_check);
  }

  @override
  void dispose() {
    widget.gate.unregister(_check);
    _title.dispose();
    _description.dispose();
    _titleFocus.dispose();
    super.dispose();
  }

  bool _check() {
    final titleOk = _title.text.trim().isNotEmpty;
    setState(() => _showTitleError = !titleOk);
    final formOk = _form.validate() != null;
    if (!titleOk) _titleFocus.requestFocus();
    return titleOk && formOk;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final draft = widget.editor.draft!;
    final schema = draft.schema;
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        AppTextField(
          key: const ValueKey('post-title'),
          label: l10n.postTitleLabel,
          hint: l10n.postTitleHint,
          controller: _title,
          focusNode: _titleFocus,
          requiredLabel: l10n.dynamicFormRequired,
          errorText: _showTitleError ? l10n.postTitleRequired : null,
          textInputAction: TextInputAction.next,
          onChanged: (value) {
            if (_showTitleError && value.trim().isNotEmpty) {
              setState(() => _showTitleError = false);
            }
            widget.editor.update((d) => d.copyWith(title: value));
          },
        ),
        const SizedBox(height: AppSpacing.md),
        AppTextField(
          key: const ValueKey('post-description'),
          label: l10n.postDescriptionLabel,
          hint: l10n.postDescriptionHint,
          controller: _description,
          keyboardType: TextInputType.multiline,
          maxLines: 6,
          minLines: 3,
          onChanged: (value) =>
              widget.editor.update((d) => d.copyWith(description: value)),
        ),
        const SizedBox(height: AppSpacing.lg),
        if (schema != null)
          DynamicForm(
            // A new category is a new form.
            key: ValueKey('fields-${draft.category!.id}'),
            schema: schema,
            controller: _form,
            // "Today" for date fields, in the tenant's zone (as the server checks).
            validationContext: ValidationContext.now(
              utcOffset: ref
                  .watch(currentTenantConfigProvider)
                  ?.timezone
                  .utcOffset,
            ),
            initialState: draft.formState,
            onStateChanged: (state) =>
                widget.editor.update((d) => d.copyWith(formState: state)),
          ),
      ],
    );
  }
}
