import 'dart:convert';
import 'dart:typed_data';

import 'package:amar_elaka_app/features/media_upload/data/media_upload_transport.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

/// Answers each request with the next scripted media status.
class _StatusAdapter implements HttpClientAdapter {
  _StatusAdapter(this.statuses);

  final List<String> statuses;
  final List<String> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add('${options.method} ${options.path}');
    return ResponseBody.fromString(
      jsonEncode({'id': 'm1', 'status': statuses.removeAt(0)}),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  DioMediaUploadTransport transport(_StatusAdapter adapter) =>
      DioMediaUploadTransport(Dio()..httpClientAdapter = adapter);

  test('confirm waits until the worker has made the photo ready', () async {
    final adapter = _StatusAdapter(['processing', 'processing', 'ready']);
    await transport(adapter).confirm('m1');
    expect(adapter.requests, [
      'POST /media/m1/confirm',
      'GET /media/m1',
      'GET /media/m1',
    ]);
  });

  test('a photo the worker rejects fails, and is not retried', () async {
    final adapter = _StatusAdapter(['processing', 'rejected']);
    await expectLater(
      transport(adapter).confirm('m1'),
      throwsA(
        isA<UploadFailure>()
            .having((f) => f.code, 'code', 'media_rejected')
            .having((f) => f.retryable, 'retryable', false),
      ),
    );
  });

  test('already ready at confirm: no waiting', () async {
    final adapter = _StatusAdapter(['ready']);
    await transport(adapter).confirm('m1');
    expect(adapter.requests, ['POST /media/m1/confirm']);
  });
}
