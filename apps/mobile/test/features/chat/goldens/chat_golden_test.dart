import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/features/chat/application/chat_outbox.dart';
import 'package:amar_elaka_app/features/chat/data/chat_models.dart';
import 'package:amar_elaka_app/features/chat/presentation/widgets/conversation_tile.dart';
import 'package:amar_elaka_app/features/chat/presentation/widgets/message_bubble.dart';
import 'package:amar_elaka_app/features/chat/presentation/widgets/post_header_card.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../post/goldens/golden_fonts.dart';
import '../chat_test_fakes.dart';

/// Goldens for the thread (ADR 060), light and dark: long Bengali that has
/// to wrap inside the bubble (conjuncts intact, no clipping), Bengali and
/// English mixed in one message, mine and theirs, every tick, pending and
/// failed; and the post card on top and an inbox row.
/// Regenerate on Linux (as CI runs): flutter test --update-goldens test/features/chat/goldens
void main() {
  setUpAll(loadAppFonts);

  const longBengali =
      '${ConjunctText.description} ${ConjunctText.title} — আগামীকাল সন্ধ্যায় ${ConjunctText.place}-এ দেখা করা যাবে?';
  const mixed =
      'iPhone 13 Pro এর battery health কত? Box আর charger সহ দিলে ৳৬০,০০০ final করবেন? OK হলে কাল 5pm-এ আসছি।';

  final conv = conversation(
    othersDeliveredUpTo: messageId(4),
    othersReadUpTo: messageId(2),
  );
  // Local time: chatTime shows toLocal(), so the golden is the same in any CI timezone.
  final at = DateTime(2026, 10, 9, 14, 5);

  Widget bubble(int n, String sender, String body) {
    final m = message(n: n, sender: sender, body: body, at: at);
    final mine = sender == buyerMemberId;
    return MessageBubble.message(
      m,
      mine: mine,
      state: mine ? deliveryStateOf(m.id, conv) : null,
    );
  }

  PendingMessage pending(String body, {bool failed = false}) => PendingMessage(
    clientMessageId: 'p-$body',
    conversationId: 'c1',
    draft: TextDraft(body),
    failed: failed,
    createdAt: at,
    errorCode: failed ? 'CHAT_CONTACT_INFO_BLOCKED' : null,
  );

  Widget app(ThemeData theme, Widget child) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: theme,
    locale: const Locale('bn'),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: Scaffold(body: child),
  );

  for (final (name, theme) in [
    ('light', AppTheme.light()),
    ('dark', AppTheme.dark()),
  ]) {
    testWidgets('chat bubbles, $name', (tester) async {
      tester.view.physicalSize = const Size(1080, 3600);
      tester.view.devicePixelRatio = 2.5;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        app(
          theme,
          ListView(
            children: [
              bubble(1, sellerMemberId, longBengali),
              bubble(2, buyerMemberId, mixed), // read
              bubble(3, sellerMemberId, mixed),
              bubble(4, buyerMemberId, 'ঠিক আছে, ধন্যবাদ!'), // delivered
              bubble(5, buyerMemberId, longBengali), // sent
              MessageBubble.pending(pending('আসছি, ১০ মিনিট')),
              MessageBubble.pending(
                pending('আমার নম্বর ০১৭১১-১১১১১১', failed: true),
                onRetry: () {},
                onDiscard: () {},
                onEdit: () {},
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final s in ['read', 'delivered', 'sent', 'pending', 'failed']) {
        expect(find.byKey(ValueKey('ticks-$s')), findsWidgets, reason: s);
      }
      await expectLater(
        find.byType(ListView),
        matchesGoldenFile('chat_bubbles_$name.png'),
      );
    });

    testWidgets('post card and inbox row, $name', (tester) async {
      tester.view.physicalSize = const Size(1080, 900);
      tester.view.devicePixelRatio = 2.5;
      addTearDown(tester.view.reset);
      final row =
          Conversation.fromJson(
            conversationJson(
              unreadCount: 3,
              postTitle: ConjunctText.title,
              counterpartName: ConjunctText.contact,
            ),
          ).copyWith(
            lastMessage: message(
              n: 9,
              sender: sellerMemberId,
              body: mixed,
              at: at,
            ),
            activityAt: at,
          );
      await tester.pumpWidget(
        app(
          theme,
          Column(
            key: const ValueKey('golden'),
            children: [
              PostHeaderCard(conversation: row),
              ConversationTile(conversation: row, onTap: () {}),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('conversation-unread-c1')),
        findsOneWidget,
      );
      await expectLater(
        find.byKey(const ValueKey('golden')),
        matchesGoldenFile('chat_header_row_$name.png'),
      );
    });
  }
}
