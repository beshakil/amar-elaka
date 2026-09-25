import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../domain/upload_item.dart';

/// Where a queue lives between app launches: the item list as JSON in
/// SharedPreferences, the compressed files in the app's support directory
/// (not the cache, which the OS may clear while an upload is pending).
abstract interface class UploadQueueStore {
  Future<List<UploadItem>> load(String queueId);
  Future<void> save(String queueId, List<UploadItem> items);

  /// A path for the compressed copy of item [itemId].
  Future<String> compressedPathFor(String itemId);
  Future<void> deleteFile(String? path);
}

class PersistentUploadQueueStore implements UploadQueueStore {
  static const _prefix = 'upload_queue.';

  @override
  Future<List<UploadItem>> load(String queueId) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('$_prefix$queueId');
    if (raw == null) return [];
    try {
      return [
        for (final item in jsonDecode(raw) as List)
          UploadItem.fromJson(item as Map<String, dynamic>),
      ];
    } on FormatException {
      return [];
    }
  }

  @override
  Future<void> save(String queueId, List<UploadItem> items) async {
    final prefs = await SharedPreferences.getInstance();
    if (items.isEmpty) {
      await prefs.remove('$_prefix$queueId');
    } else {
      await prefs.setString(
        '$_prefix$queueId',
        jsonEncode([for (final item in items) item.toJson()]),
      );
    }
  }

  @override
  Future<String> compressedPathFor(String itemId) async {
    final dir = Directory(
      '${(await getApplicationSupportDirectory()).path}/uploads',
    );
    await dir.create(recursive: true);
    return '${dir.path}/$itemId.webp';
  }

  @override
  Future<void> deleteFile(String? path) async {
    if (path == null) return;
    final file = File(path);
    if (await file.exists()) await file.delete();
  }
}
