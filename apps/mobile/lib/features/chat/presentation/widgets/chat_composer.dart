import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../l10n/app_localizations.dart';
import '../../data/chat_models.dart';

enum AttachChoice { gallery, camera, location }

/// The composer (ADR 060): quick replies for a store's staff (tap to put it
/// in the box, edit, send), a text box that grows, attach (photo, camera,
/// location) and send. Disabled, with the reason, when nobody can send.
class ChatComposer extends StatelessWidget {
  const ChatComposer({
    required this.controller,
    required this.enabled,
    required this.onSend,
    required this.onChanged,
    required this.onAttach,
    this.quickReplies = const [],
    this.disabledReason,
    super.key,
  });

  final TextEditingController controller;
  final bool enabled;
  final VoidCallback onSend;
  final ValueChanged<String> onChanged;
  final ValueChanged<AttachChoice> onAttach;
  final List<QuickReply> quickReplies;
  final String? disabledReason;

  static const _maxLines = 5;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    if (!enabled) {
      return SafeArea(
        top: false,
        child: Container(
          key: const ValueKey('chat-composer-disabled'),
          width: double.infinity,
          padding: const EdgeInsets.all(AppSpacing.md),
          color: theme.colorScheme.surfaceContainer,
          child: Text(
            disabledReason ?? l10n.chatBlockedNotice,
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return SafeArea(
      top: false,
      child: Material(
        color: theme.colorScheme.surface,
        elevation: 2,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (quickReplies.isNotEmpty)
              SizedBox(
                height: 48,
                child: ListView(
                  key: const ValueKey('chat-quick-replies'),
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.sm,
                  ),
                  children: [
                    for (final q in quickReplies)
                      Padding(
                        padding: const EdgeInsets.only(
                          right: AppSpacing.xs,
                          top: AppSpacing.xs,
                        ),
                        child: ActionChip(
                          label: Text(
                            q.body,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          tooltip: l10n.chatQuickReplies,
                          onPressed: () {
                            controller.text = q.body;
                            controller.selection = TextSelection.collapsed(
                              offset: q.body.length,
                            );
                            onChanged(q.body);
                          },
                        ),
                      ),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.xs,
                AppSpacing.xs,
                AppSpacing.xs,
                AppSpacing.xs,
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  PopupMenuButton<AttachChoice>(
                    key: const ValueKey('chat-attach'),
                    tooltip: l10n.chatAttach,
                    icon: const Icon(Icons.add_circle_outline),
                    onSelected: onAttach,
                    itemBuilder: (_) => [
                      PopupMenuItem(
                        value: AttachChoice.gallery,
                        child: ListTile(
                          leading: const Icon(Icons.photo_outlined),
                          title: Text(l10n.chatSendPhoto),
                        ),
                      ),
                      PopupMenuItem(
                        value: AttachChoice.camera,
                        child: ListTile(
                          leading: const Icon(Icons.photo_camera_outlined),
                          title: Text(l10n.chatTakePhoto),
                        ),
                      ),
                      PopupMenuItem(
                        value: AttachChoice.location,
                        child: ListTile(
                          leading: const Icon(Icons.location_on_outlined),
                          title: Text(l10n.chatShareLocation),
                        ),
                      ),
                    ],
                  ),
                  Expanded(
                    child: TextField(
                      key: const ValueKey('chat-input'),
                      controller: controller,
                      minLines: 1,
                      maxLines: _maxLines,
                      textCapitalization: TextCapitalization.sentences,
                      keyboardType: TextInputType.multiline,
                      onChanged: onChanged,
                      decoration: InputDecoration(
                        hintText: l10n.chatComposerHint,
                        border: const OutlineInputBorder(
                          borderRadius: BorderRadius.all(Radius.circular(24)),
                        ),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.md,
                          vertical: AppSpacing.sm,
                        ),
                      ),
                    ),
                  ),
                  ValueListenableBuilder<TextEditingValue>(
                    valueListenable: controller,
                    builder: (context, value, _) => IconButton.filled(
                      key: const ValueKey('chat-send'),
                      tooltip: l10n.chatSend,
                      onPressed: value.text.trim().isEmpty ? null : onSend,
                      icon: const Icon(Icons.send),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
