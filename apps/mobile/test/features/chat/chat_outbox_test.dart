import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/features/chat/application/chat_outbox.dart';
import 'package:amar_elaka_app/features/chat/data/chat_api.dart';
import 'package:amar_elaka_app/features/chat/data/chat_models.dart';
import 'package:flutter_test/flutter_test.dart';

import '../media_upload/upload_fakes.dart';
import '../post/post_test_harness.dart';
import 'chat_test_fakes.dart';

/// The offline composer's queue (ADR 060): pending first, sent once the
/// server has it, retried while the network is the problem, failed (with
/// its reason) when the server refuses for good.
void main() {
  late AppDatabase db;
  late FakeChatApi api;
  late ChatOutbox outbox;

  setUp(() {
    db = memoryDatabase();
    api = FakeChatApi();
    outbox = ChatOutbox(db: db, api: api, compressor: FakeCompressor());
  });

  tearDown(() async {
    outbox.dispose();
    await db.close();
  });

  Future<List<PendingMessage>> pending() => outbox.watch('c1').first;

  test('a message is pending, then sent and gone from the queue', () async {
    final sent = <SendResult>[];
    outbox.sent.listen(sent.add);
    api.sendFailures.add(null); // offline at first
    await outbox.enqueue('c1', const TextDraft('দাম কত হবে?'));
    await outbox.flush();
    final waiting = await pending();
    expect(waiting.single.failed, isFalse);
    expect((waiting.single.draft as TextDraft).body, 'দাম কত হবে?');
    expect(api.sent, isEmpty);

    await outbox.flush(); // the network is back
    expect(await pending(), isEmpty);
    expect(api.sent.single.$1, 'c1');
    expect(sent.single.created, isTrue);
  });

  test('messages go oldest first, and each client id once', () async {
    api.sendFailures.add(null);
    await outbox.enqueue('c1', const TextDraft('এক'));
    await outbox.flush();
    await outbox.enqueue('c1', const TextDraft('দুই'));
    await outbox.flush();
    expect([for (final s in api.sent) (s.$3 as TextDraft).body], ['এক', 'দুই']);
    expect(api.sent.map((s) => s.$2).toSet(), hasLength(2));
  });

  test('a replay of an accepted message is not a second message', () async {
    final id = await outbox.enqueue('c1', const TextDraft('হ্যালো'));
    await outbox.flush();
    final again = await api.send('c1', id, const TextDraft('হ্যালো'));
    expect(again.created, isFalse);
    expect(api.messages['c1'], hasLength(1));
  });

  test('a refusal fails it with its code; retry sends it', () async {
    api.sendFailures.add(chatApiError(422, 'CHAT_CONTACT_INFO_BLOCKED'));
    final id = await outbox.enqueue(
      'c1',
      const TextDraft('ফোন দিন ০১৭১১১১১১১১'),
    );
    await outbox.flush();
    final failed = (await pending()).single;
    expect(failed.failed, isTrue);
    expect(failed.errorCode, 'CHAT_CONTACT_INFO_BLOCKED');
    expect(api.sent, isEmpty);

    await outbox.retry(id);
    await outbox.flush();
    expect(await pending(), isEmpty);
    expect(api.sent, hasLength(1));
  });

  test('a server error or a lapsed session waits instead of failing', () async {
    api.sendFailures.addAll([
      chatApiError(503, 'UNAVAILABLE'),
      chatApiError(401, 'UNAUTHENTICATED'),
    ]);
    await outbox.enqueue('c1', const TextDraft('আছেন?'));
    await outbox.flush();
    expect((await pending()).single.failed, isFalse);
    await outbox.flush();
    expect((await pending()).single.failed, isFalse);
    await outbox.flush();
    expect(await pending(), isEmpty);
  });

  test('discard drops a failed message', () async {
    api.sendFailures.add(chatApiError(403, 'CHAT_BLOCKED'));
    final id = await outbox.enqueue('c1', const TextDraft('শেষ'));
    await outbox.flush();
    await outbox.discard(id);
    expect(await pending(), isEmpty);
  });

  test('client ids are URL-safe and 8–64 characters', () {
    final ids = List.generate(50, (_) => newClientMessageId());
    expect(ids.toSet(), hasLength(50));
    for (final id in ids) {
      expect(id, matches(RegExp(r'^[A-Za-z0-9_-]{8,64}$')));
    }
  });
}
