import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter_image_compress/flutter_image_compress.dart';

/// Compression rules applied on the phone BEFORE upload: users pay for data,
/// so a 5 MB camera photo leaves the phone as a ~150 KB WebP.
abstract final class UploadCompression {
  /// Longest edge after compression.
  static const maxLongEdge = 1200;
  static const webpQuality = 80;
}

abstract interface class ImageCompressor {
  /// Writes a compressed WebP of [sourcePath] to [targetPath]; returns its size in bytes.
  Future<int> compress(String sourcePath, String targetPath);
}

/// The single min-bound flutter_image_compress needs for "long edge at most
/// [maxLongEdge]". The plugin scales by `min(width / minWidth, height /
/// minHeight)` (never up), so passing 1200 for both would size the SHORT
/// side to 1200. One bound of `short × max / long` yields a scale of exactly
/// `long / max` whichever way EXIF rotates the photo, and never enlarges.
int compressionBound(
  int width,
  int height, [
  int maxLongEdge = UploadCompression.maxLongEdge,
]) {
  final longEdge = math.max(width, height);
  final shortEdge = math.min(width, height);
  if (longEdge <= maxLongEdge) return shortEdge;
  return (shortEdge * maxLongEdge / longEdge).floor();
}

class PluginImageCompressor implements ImageCompressor {
  @override
  Future<int> compress(String sourcePath, String targetPath) async {
    final (width, height) = await _dimensions(sourcePath);
    final bound = compressionBound(width, height);
    final result = await FlutterImageCompress.compressAndGetFile(
      sourcePath,
      targetPath,
      minWidth: bound,
      minHeight: bound,
      quality: UploadCompression.webpQuality,
      format: CompressFormat.webp,
      // No location or camera data leaves the phone (the server strips it again).
      keepExif: false,
      autoCorrectionAngle: true,
    );
    if (result == null) {
      throw const FileSystemException('compression produced no file');
    }
    return File(result.path).length();
  }

  /// Reads only the header, not the whole bitmap.
  Future<(int, int)> _dimensions(String path) async {
    final buffer = await ui.ImmutableBuffer.fromFilePath(path);
    final descriptor = await ui.ImageDescriptor.encoded(buffer);
    final size = (descriptor.width, descriptor.height);
    descriptor.dispose();
    buffer.dispose();
    return size;
  }
}
