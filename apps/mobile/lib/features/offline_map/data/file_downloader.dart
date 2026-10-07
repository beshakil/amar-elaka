import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';

/// The file arrived, but not as the server described it.
class ChecksumMismatchException implements Exception {
  const ChecksumMismatchException(this.path);

  final String path;

  @override
  String toString() => 'ChecksumMismatchException($path)';
}

/// Downloads one file to disk, resuming a partial one with a `Range`
/// request (the tiles route answers 206, ADR 043/050), with progress, a
/// timeout per connection and a few attempts (CLAUDE.md rule 5).
class FileDownloader {
  FileDownloader(this._dio, {this.maxAttempts = 3});

  final Dio _dio;
  final int maxAttempts;

  /// Leaves a complete [target] of [expectedBytes]. [onProgress] gets the
  /// bytes on disk so far (resumed bytes included).
  Future<void> download(
    String url,
    File target, {
    required int expectedBytes,
    void Function(int received)? onProgress,
    CancelToken? cancel,
  }) async {
    await target.parent.create(recursive: true);
    for (var attempt = 1; ; attempt++) {
      var start = await target.exists() ? await target.length() : 0;
      if (start > expectedBytes) {
        await target.delete();
        start = 0;
      }
      if (start == expectedBytes) {
        onProgress?.call(start);
        return;
      }
      try {
        final response = await _dio.get<ResponseBody>(
          url,
          cancelToken: cancel,
          options: Options(
            responseType: ResponseType.stream,
            headers: start > 0 ? {'range': 'bytes=$start-'} : null,
            validateStatus: (status) => status == 200 || status == 206,
          ),
        );
        // A server that ignored the range sends the whole file again.
        final append = response.statusCode == 206;
        var received = append ? start : 0;
        final sink = target.openWrite(
          mode: append ? FileMode.append : FileMode.write,
        );
        try {
          await for (final chunk in response.data!.stream) {
            sink.add(chunk);
            received += chunk.length;
            onProgress?.call(received);
          }
        } finally {
          await sink.close();
        }
        if (received >= expectedBytes) return;
      } on DioException catch (e) {
        if (e.type == DioExceptionType.cancel || attempt >= maxAttempts) {
          throw mapDioException(e);
        }
      } on IOException {
        // The connection dropped mid-stream: what arrived stays, resume.
        if (cancel?.isCancelled ?? false) rethrow;
        if (attempt >= maxAttempts) throw const NetworkException();
      }
      if (attempt >= maxAttempts) {
        throw const NetworkException();
      }
    }
  }
}

/// SHA-256 of a file, streamed (the archive is megabytes).
Future<String> sha256OfFile(File file) async =>
    (await sha256.bind(file.openRead()).first).toString();

/// A plain client for the tiles host: absolute URLs, no API headers.
final fileDownloaderProvider = Provider<FileDownloader>(
  (ref) => FileDownloader(
    Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 60),
      ),
    ),
  ),
);
