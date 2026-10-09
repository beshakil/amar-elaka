import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../../core/network/dio_client.dart';
import '../../post/application/current_tenant.dart';
import '../../media_upload/data/image_compressor.dart';
import '../../media_upload/data/media_upload_transport.dart';

/// A store's logo or banner (ADR 057): one photo, compressed on the phone
/// the way post photos are, then presign → PUT → confirm, returning once the
/// worker has made it `ready` — the only state a store accepts. The same
/// compressor and transport as the post photo queue; nothing new.
class StoreImageUploader {
  StoreImageUploader(this._compressor, this._transport);

  final ImageCompressor _compressor;
  final MediaUploadTransport _transport;

  /// The ready media's id. Throws [UploadFailure] when it can't be uploaded.
  Future<String> upload(String sourcePath) async {
    final dir = await getTemporaryDirectory();
    final target =
        '${dir.path}/store-${DateTime.now().microsecondsSinceEpoch}.webp';
    await _compressor.compress(sourcePath, target);
    final file = File(target);
    try {
      final bytes = await file.readAsBytes();
      final presigned = await _transport.presign(
        byteSize: bytes.length,
        sha256: sha256.convert(bytes).toString(),
        contentType: 'image/webp',
      );
      await _transport.put(presigned, file, onProgress: (_) {});
      await _transport.confirm(presigned.mediaId);
      return presigned.mediaId;
    } finally {
      if (file.existsSync()) await file.delete();
    }
  }
}

final storeImageUploaderProvider = Provider<StoreImageUploader>((ref) {
  final media = ref.read(currentTenantConfigProvider)?.media;
  return StoreImageUploader(
    PluginImageCompressor(
      maxLongEdge: media?.imageMaxLongEdgePx ?? UploadCompression.maxLongEdge,
      quality: media?.imageQuality ?? UploadCompression.webpQuality,
    ),
    DioMediaUploadTransport(ref.watch(dioClientProvider)),
  );
});
