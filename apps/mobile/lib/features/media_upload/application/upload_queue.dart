import 'dart:io';
import 'dart:math' as math;

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../data/image_compressor.dart';
import '../data/media_upload_transport.dart';
import '../data/upload_queue_store.dart';
import '../domain/upload_item.dart';

/// The photos of one post (or store, or chat) being prepared: compressed on
/// the phone, uploaded straight to storage, confirmed with the API.
///
///  - Two uploads run at once; the rest wait their turn.
///  - A failed step is retried with backoff when it's worth retrying (network,
///    timeout, rate limit); a refused file (not an image, too big) fails at once.
///  - Every state change is saved, so a queue killed mid-upload resumes on the
///    next launch ([restore]): unfinished items start again from the step they
///    need (a presigned URL expires, so an interrupted PUT is redone whole —
///    cheap, since files are ~150 KB after compression).
///  - Items can be reordered and removed at any time; removing one cancels its
///    upload. The server deletes anything uploaded but never attached (orphan
///    sweep), so nothing needs to be "un-uploaded".
class UploadQueue extends ChangeNotifier {
  UploadQueue({
    required this.queueId,
    required this._compressor,
    required this._transport,
    required this._store,
    this.maxItems = defaultMaxItems,
    this.concurrency = defaultConcurrency,
    this.retryDelays = defaultRetryDelays,
    this._delay = Future<void>.delayed,
    String Function()? newId,
  }) : _newId = newId ?? _randomId;

  /// Photos per post.
  static const defaultMaxItems = 10;
  static const defaultConcurrency = 2;

  /// Waits before the 2nd, 3rd and 4th attempt; then the item fails.
  static const defaultRetryDelays = [
    Duration(seconds: 2),
    Duration(seconds: 6),
    Duration(seconds: 20),
  ];

  final String queueId;
  final int maxItems;
  final int concurrency;
  final List<Duration> retryDelays;
  final ImageCompressor _compressor;
  final MediaUploadTransport _transport;
  final UploadQueueStore _store;
  final Future<void> Function(Duration) _delay;
  final String Function() _newId;

  List<UploadItem> _items = [];
  final Map<String, CancelToken> _cancelTokens = {};
  final Set<String> _running = {};
  bool _disposed = false;

  List<UploadItem> get items => List.unmodifiable(_items);
  int get remainingSlots => maxItems - _items.length;

  /// True when every photo is uploaded and confirmed.
  bool get isComplete =>
      _items.isNotEmpty && _items.every((i) => i.status == UploadStatus.done);

  /// Confirmed media ids in the user's chosen order, for the post.
  List<String> get mediaIds => [
    for (final item in _items)
      if (item.status == UploadStatus.done) item.mediaId!,
  ];

  /// Loads a saved queue and resumes whatever was unfinished.
  Future<void> restore() async {
    final saved = await _store.load(queueId);
    _items = [
      for (final item in saved)
        item.isActive
            ? item.copyWith(status: UploadStatus.queued, progress: 0)
            : item,
    ];
    _changed();
    _pump();
  }

  /// Adds picked photos, up to [maxItems] in total; returns how many were taken.
  Future<int> add(List<String> sourcePaths) async {
    final taken = sourcePaths.take(math.max(0, remainingSlots)).toList();
    _items = [
      ..._items,
      for (final path in taken) UploadItem(id: _newId(), sourcePath: path),
    ];
    await _save();
    _pump();
    return taken.length;
  }

  Future<void> remove(String id) async {
    final item = _find(id);
    if (item == null) return;
    _cancelTokens.remove(id)?.cancel();
    _items = [
      for (final i in _items)
        if (i.id != id) i,
    ];
    await _save();
    await _store.deleteFile(item.compressedPath);
    _pump();
  }

  /// Moves an item so it ends up at [newIndex] (`onReorderItem` semantics).
  Future<void> reorder(int oldIndex, int newIndex) async {
    final items = [..._items];
    final item = items.removeAt(oldIndex);
    items.insert(newIndex, item);
    _items = items;
    await _save();
  }

  Future<void> retry(String id) async {
    final item = _find(id);
    if (item == null || item.status != UploadStatus.failed) return;
    _update(
      id,
      (i) => i.copyWith(
        status: UploadStatus.queued,
        attempts: 0,
        progress: 0,
        clearError: true,
      ),
    );
    await _save();
    _pump();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final token in _cancelTokens.values) {
      token.cancel();
    }
    super.dispose();
  }

  void _pump() {
    if (_disposed) return;
    for (final item in _items) {
      if (_running.length >= concurrency) break;
      if (item.status == UploadStatus.queued && !_running.contains(item.id)) {
        _running.add(item.id);
        _run(item.id).whenComplete(() {
          _running.remove(item.id);
          _pump();
        });
      }
    }
  }

  Future<void> _run(String id) async {
    while (!_disposed && _find(id) != null) {
      try {
        await _attempt(id);
        return;
      } on UploadFailure catch (failure) {
        if (_find(id) == null || failure.code == 'cancelled') return;
        final attempts = _find(id)!.attempts + 1;
        final retry = failure.retryable && attempts <= retryDelays.length;
        _update(
          id,
          (i) => i.copyWith(
            attempts: attempts,
            status: retry ? UploadStatus.queued : UploadStatus.failed,
            errorCode: failure.code,
            progress: 0,
          ),
        );
        await _save();
        if (!retry) return;
        await _delay(retryDelays[attempts - 1]);
      } on Exception {
        // Compression or file errors: the photo can't be used as it is.
        if (_find(id) == null) return;
        _update(
          id,
          (i) =>
              i.copyWith(status: UploadStatus.failed, errorCode: 'compression'),
        );
        await _save();
        return;
      }
    }
  }

  Future<void> _attempt(String id) async {
    var item = _find(id)!;
    final compressed = item.compressedPath;
    if (compressed == null || !await File(compressed).exists()) {
      _update(id, (i) => i.copyWith(status: UploadStatus.compressing));
      final target = await _store.compressedPathFor(id);
      final size = await _compressor.compress(item.sourcePath, target);
      if (_find(id) == null) return _store.deleteFile(target);
      _update(id, (i) => i.copyWith(compressedPath: target, byteSize: size));
      await _save();
    }

    item = _find(id)!;
    final file = File(item.compressedPath!);
    final bytes = await file.readAsBytes();
    _update(id, (i) => i.copyWith(status: UploadStatus.uploading, progress: 0));
    await _save();

    final target = await _transport.presign(
      byteSize: bytes.length,
      sha256: sha256.convert(bytes).toString(),
      contentType: 'image/webp',
    );
    final token = _cancelTokens[id] = CancelToken();
    try {
      await _transport.put(
        target,
        file,
        cancelToken: token,
        onProgress: (progress) =>
            _update(id, (i) => i.copyWith(progress: progress)),
      );
    } finally {
      _cancelTokens.remove(id);
    }
    if (_find(id) == null) return;

    _update(
      id,
      (i) => i.copyWith(status: UploadStatus.confirming, progress: 1),
    );
    await _transport.confirm(target.mediaId);
    _update(
      id,
      (i) => i.copyWith(
        status: UploadStatus.done,
        mediaId: target.mediaId,
        clearError: true,
      ),
    );
    await _save();
  }

  UploadItem? _find(String id) => _items.where((i) => i.id == id).firstOrNull;

  /// Changes one item in memory; callers [_save] at the state changes worth persisting.
  void _update(String id, UploadItem Function(UploadItem) change) {
    _items = [
      for (final i in _items)
        if (i.id == id) change(i) else i,
    ];
    _changed();
  }

  Future<void> _save() async {
    await _store.save(queueId, _items);
    _changed();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  static String _randomId() {
    final random = math.Random.secure();
    return List.generate(
      16,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }
}

/// One queue per draft (e.g. `post-draft:<uuid>`); restored on first use.
final uploadQueueProvider = Provider.autoDispose.family<UploadQueue, String>((
  ref,
  queueId,
) {
  final queue = UploadQueue(
    queueId: queueId,
    compressor: PluginImageCompressor(),
    transport: DioMediaUploadTransport(ref.watch(dioClientProvider)),
    store: PersistentUploadQueueStore(),
  );
  ref.onDispose(queue.dispose);
  queue.restore();
  return queue;
});
