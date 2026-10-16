import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../../core/network/connectivity_provider.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/storage/app_database_provider.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';
import '../../media_upload/data/image_compressor.dart';
import '../../media_upload/data/media_upload_transport.dart';
import '../../post/application/current_tenant.dart';
import '../data/agent_api.dart';
import '../data/agent_bootstrap.dart';
import '../data/agent_capture_store.dart';
import '../data/agent_models.dart';
import '../data/gps_source.dart';
import 'agent_sync.dart';

/// Agent mode is unlocked by the role (ADR 066); the API checks it again.
final isFieldAgentProvider = Provider<bool>((ref) {
  final auth = ref.watch(authControllerProvider);
  return auth is AuthSessionAuthenticated && auth.me.role == 'agent';
});

final agentCaptureStoreProvider = Provider<AgentCaptureStore>(
  (ref) => AgentCaptureStore(ref.watch(appDatabaseProvider)),
);

final gpsSourceProvider = Provider<GpsSource>(
  (ref) => const GeolocatorGpsSource(),
);

final agentBootstrapStoreProvider = Provider<AgentBootstrapStore>(
  (ref) => AgentBootstrapStore(ref.watch(agentApiProvider)),
);

/// The agent's profile, settings and categories — fresh, or kept from the last time online.
final agentBootstrapProvider = FutureProvider<AgentBootstrap?>((ref) async {
  final tenantId = ref.watch(currentTenantConfigProvider)?.id;
  if (tenantId == null || !ref.watch(isFieldAgentProvider)) return null;
  return ref.watch(agentBootstrapStoreProvider).load(tenantId);
});

final agentSyncProvider = Provider<AgentSync>((ref) {
  final sync = AgentSync(
    store: ref.watch(agentCaptureStoreProvider),
    api: ref.watch(agentApiProvider),
    transport: DioMediaUploadTransport(ref.watch(dioClientProvider)),
  );
  // Back online: send what waited. On start: what waited from the last run.
  ref.listen(isOnlineProvider, (previous, next) {
    if (next.value == true && previous?.value != true) {
      unawaited(sync.syncAll());
    }
  });
  unawaited(sync.syncAll());
  return sync;
});

/// The queue, newest first, as the agent's queue screen shows it.
final agentQueueProvider = StreamProvider.autoDispose<List<AgentCapture>>((
  ref,
) {
  final tenantId = ref.watch(currentTenantConfigProvider)?.id;
  if (tenantId == null) return Stream.value(const []);
  return ref.watch(agentCaptureStoreProvider).watch(tenantId);
});

final agentTodayProvider = FutureProvider.autoDispose<AgentToday>(
  (ref) => ref.watch(agentApiProvider).today(),
);

final agentStatsProvider = FutureProvider.autoDispose<AgentStats>(
  (ref) => ref.watch(agentApiProvider).stats(),
);

/// Shrinks a camera photo and keeps it with the capture until it syncs
/// (the app's support directory: not a cache the system may clear).
class CapturePhotoProcessor {
  CapturePhotoProcessor(this._compressor, {Future<Directory> Function()? dir})
    : _dir = dir ?? getApplicationSupportDirectory;

  final ImageCompressor _compressor;
  final Future<Directory> Function() _dir;

  Future<CapturedPhoto> keep(
    String sourcePath,
    String captureId,
    int position,
  ) async {
    final base = await _dir();
    final folder = Directory('${base.path}/agent_captures/$captureId');
    await folder.create(recursive: true);
    final target = '${folder.path}/$position.webp';
    final size = await _compressor.compress(sourcePath, target);
    final digest = sha256.convert(await File(target).readAsBytes()).toString();
    return CapturedPhoto(localPath: target, byteSize: size, sha256: digest);
  }
}

final capturePhotoProcessorProvider = Provider<CapturePhotoProcessor>(
  (ref) => CapturePhotoProcessor(PluginImageCompressor()),
);
