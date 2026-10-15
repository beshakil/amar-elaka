import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../media_upload/data/image_compressor.dart';
import '../data/verification_api.dart';

/// Compresses a picked photo to WebP and uploads it as private evidence for
/// the member (storeId null) or a store; returns its media id. The
/// temporary copy is deleted either way.
typedef EvidenceUploader =
    Future<String> Function(String path, {String? storeId});

final evidenceUploaderProvider = Provider<EvidenceUploader>((ref) {
  final api = ref.watch(verificationApiProvider);
  return (path, {storeId}) async {
    final dir = await getTemporaryDirectory();
    final target =
        '${dir.path}/verification-${DateTime.now().microsecondsSinceEpoch}.webp';
    await PluginImageCompressor().compress(path, target);
    final file = File(target);
    try {
      return await api.uploadEvidence(file, storeId: storeId);
    } finally {
      if (file.existsSync()) unawaited(file.delete());
    }
  };
});
