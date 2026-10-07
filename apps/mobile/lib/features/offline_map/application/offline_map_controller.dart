import 'dart:async' show StreamSubscription, unawaited;

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/connectivity_provider.dart';
import '../../../core/storage/app_database.dart';
import '../../post/application/current_tenant.dart';
import '../data/file_downloader.dart';
import '../data/offline_map_repository.dart';
import 'offline_map_prefs.dart';

enum OfflineMapPhase { idle, checking, downloading, failed }

/// Why the last check or download didn't work (the screen words each).
enum OfflineMapError { network, checksum, notAvailable, tooLarge, failed }

class OfflineMapState {
  const OfflineMapState({
    this.installed,
    this.manifest,
    this.phase = OfflineMapPhase.idle,
    this.done = 0,
    this.total = 0,
    this.error,
  });

  /// What's on the phone (null: nothing downloaded).
  final OfflineMapRow? installed;

  /// The server's latest answer (null: not asked yet).
  final OfflineMapManifest? manifest;
  final OfflineMapPhase phase;
  final int done;
  final int total;
  final OfflineMapError? error;

  /// The server has a different (newer) version than the one installed.
  bool get updateAvailable {
    final archive = manifest?.archive;
    final row = installed;
    return row != null && archive != null && archive.version != row.version;
  }

  double get progress => total == 0 ? 0 : done / total;

  OfflineMapState copyWith({
    OfflineMapRow? installed,
    bool clearInstalled = false,
    OfflineMapManifest? manifest,
    OfflineMapPhase? phase,
    int? done,
    int? total,
    OfflineMapError? error,
    bool clearError = false,
  }) => OfflineMapState(
    installed: clearInstalled ? null : (installed ?? this.installed),
    manifest: manifest ?? this.manifest,
    phase: phase ?? this.phase,
    done: done ?? this.done,
    total: total ?? this.total,
    error: clearError ? null : (error ?? this.error),
  );
}

/// "এলাকার ম্যাপ ডাউনলোড" (ADR 050): checks the server's offline file for
/// this tenant, downloads it (resuming, verified), deletes it, and keeps it
/// up to date on Wi-Fi when the user allows.
class OfflineMapController extends Notifier<OfflineMapState> {
  CancelToken? _cancel;
  StreamSubscription<OfflineMapRow?>? _watch;

  OfflineMapRepository get _repo => ref.read(offlineMapRepositoryProvider);
  String? get _tenantId => ref.read(currentTenantConfigProvider)?.id;

  @override
  OfflineMapState build() {
    final tenantId = ref.watch(currentTenantConfigProvider)?.id;
    unawaited(_watch?.cancel());
    if (tenantId != null) {
      _watch = ref
          .watch(offlineMapRepositoryProvider)
          .watch(tenantId)
          .listen(
            (row) => _emit(
              () => row == null
                  ? state.copyWith(clearInstalled: true)
                  : state.copyWith(installed: row),
            ),
          );
    }
    ref.onDispose(() {
      unawaited(_watch?.cancel());
      _cancel?.cancel();
    });
    return const OfflineMapState();
  }

  /// Asks the server what's there (size, version).
  Future<void> check() async {
    final tenantId = _tenantId;
    if (tenantId == null || state.phase == OfflineMapPhase.downloading) return;
    _emit(
      () => state.copyWith(phase: OfflineMapPhase.checking, clearError: true),
    );
    try {
      final manifest = await _repo.manifest();
      await _repo.markChecked(tenantId);
      _emit(
        () => state.copyWith(
          manifest: manifest,
          phase: OfflineMapPhase.idle,
          error: manifest.available ? null : _unavailable(manifest),
          clearError: manifest.available,
        ),
      );
    } on AppException catch (e) {
      _emit(
        () => state.copyWith(phase: OfflineMapPhase.failed, error: _errorOf(e)),
      );
    }
  }

  /// Downloads (or resumes) and installs the server's file.
  Future<void> download() async {
    final tenantId = _tenantId;
    if (tenantId == null || state.phase == OfflineMapPhase.downloading) return;
    var manifest = state.manifest;
    if (manifest == null || !manifest.available) {
      await check();
      if (!ref.mounted) return;
      manifest = state.manifest;
      if (manifest == null || !manifest.available) return;
    }
    final ready = manifest;
    final cancel = _cancel = CancelToken();
    _emit(
      () => state.copyWith(
        phase: OfflineMapPhase.downloading,
        done: 0,
        total: ready.totalBytes,
        clearError: true,
      ),
    );
    try {
      final row = await _repo.install(
        tenantId,
        ready,
        cancel: cancel,
        onProgress: (done, total) =>
            _emit(() => state.copyWith(done: done, total: total)),
      );
      _emit(() => state.copyWith(installed: row, phase: OfflineMapPhase.idle));
    } on ChecksumMismatchException {
      _emit(
        () => state.copyWith(
          phase: OfflineMapPhase.failed,
          error: OfflineMapError.checksum,
        ),
      );
    } on AppException catch (e) {
      // Cancelled: back to idle, the partial files stay for a resume.
      _emit(
        () => cancel.isCancelled
            ? state.copyWith(phase: OfflineMapPhase.idle)
            : state.copyWith(phase: OfflineMapPhase.failed, error: _errorOf(e)),
      );
    } on Object {
      _emit(
        () => state.copyWith(
          phase: OfflineMapPhase.failed,
          error: OfflineMapError.failed,
        ),
      );
    } finally {
      _cancel = null;
    }
  }

  void cancel() => _cancel?.cancel();

  Future<void> delete() async {
    final tenantId = _tenantId;
    if (tenantId == null) return;
    _cancel?.cancel();
    await _repo.delete(tenantId);
    _emit(
      () => state.copyWith(
        clearInstalled: true,
        phase: OfflineMapPhase.idle,
        done: 0,
        clearError: true,
      ),
    );
  }

  /// On app start: when a map is installed and its check interval has
  /// passed, look for a newer version; download it only on Wi-Fi and only
  /// when the user allows. Otherwise the screen shows "new version".
  Future<void> maybeAutoUpdate({DateTime? now}) async {
    final installed = state.installed ?? await _currentRow();
    if (installed == null) return;
    final due = installed.checkedAt.add(
      Duration(hours: installed.updateCheckHours),
    );
    if ((now ?? DateTime.now()).isBefore(due)) return;
    await check();
    if (!state.updateAvailable) return;
    final prefs = await ref.read(offlineMapPrefsProvider.future);
    if (prefs.autoUpdateOnWifi && await ref.read(wifiCheckProvider).onWifi()) {
      await download();
    }
  }

  Future<OfflineMapRow?> _currentRow() async {
    final tenantId = _tenantId;
    if (tenantId == null) return null;
    final row = await _repo.current(tenantId);
    if (row != null) _emit(() => state.copyWith(installed: row));
    return row;
  }

  /// Sets the state unless this controller is already gone (the area changed,
  /// or the app tore it down mid-download): the work finishing late is fine,
  /// writing to a disposed provider is not.
  void _emit(OfflineMapState Function() next) {
    if (ref.mounted) state = next();
  }

  static OfflineMapError _unavailable(OfflineMapManifest manifest) =>
      manifest.reason == 'too_large'
      ? OfflineMapError.tooLarge
      : OfflineMapError.notAvailable;

  static OfflineMapError _errorOf(AppException e) =>
      e is NetworkException || e is TimeoutException
      ? OfflineMapError.network
      : OfflineMapError.failed;
}

final offlineMapControllerProvider =
    NotifierProvider<OfflineMapController, OfflineMapState>(
      OfflineMapController.new,
    );

/// The installed offline map of the current tenant (null: none), live.
final installedOfflineMapProvider = StreamProvider<OfflineMapRow?>((ref) {
  final tenantId = ref.watch(currentTenantConfigProvider)?.id;
  if (tenantId == null) return Stream.value(null);
  return ref.watch(offlineMapRepositoryProvider).watch(tenantId);
});

/// Looks for a newer downloaded-map version once per app run (per area),
/// when the connection is there: [OfflineMapController.maybeAutoUpdate]
/// decides whether it's due and whether it may download (Wi-Fi, the user's
/// switch). Listened to by the app root, like DraftSync.
final offlineMapAutoUpdateProvider = Provider<void>((ref) {
  final tenantId = ref.watch(currentTenantConfigProvider)?.id;
  if (tenantId == null) return;
  var done = false;
  ref.listen(isOnlineProvider, (previous, next) {
    if (done || next.value != true) return;
    done = true;
    unawaited(
      ref
          .read(offlineMapControllerProvider.notifier)
          .maybeAutoUpdate()
          .catchError((Object _) {}),
    );
  }, fireImmediately: true);
});
