import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/session_signal.dart';
import '../../../core/storage/me_cache.dart';
import '../data/auth_repository.dart';
import '../data/google_sign_in_service.dart';
import '../domain/auth_session_state.dart';
import '../domain/google_auth_result.dart';

part 'auth_controller.g.dart';

/// Session state + the auth actions the presentation layer calls. The
/// router's redirect logic watches this directly.
@riverpod
class AuthController extends _$AuthController {
  @override
  AuthSessionState build() {
    // RefreshInterceptor gave up (refresh token rejected/missing) somewhere
    // in the app — drop straight to unauthenticated instead of waiting for
    // the next `/auth/me` call to notice.
    ref.listen(sessionSignalProvider, (previous, next) {
      if (previous != null && next != previous) {
        state = const AuthSessionUnauthenticated();
      }
    });
    unawaited(_checkExistingSession());
    return const AuthSessionUnknown();
  }

  Future<void> _checkExistingSession() async {
    final storage = ref.read(secureSessionStorageProvider);
    final token = await storage.readAccessToken();
    if (token == null) {
      state = const AuthSessionUnauthenticated();
      return;
    }
    try {
      final me = await ref.read(authRepositoryProvider).me();
      await _cacheMe(me);
      state = AuthSessionAuthenticated(me);
    } on NetworkException {
      await _fallBackToCachedMe();
    } on TimeoutException {
      await _fallBackToCachedMe();
    } on AppException {
      // A real rejection (expired/invalid token, banned account, ...) — the
      // stored token is stale, so the cached identity shouldn't linger either.
      final cache = await ref.read(meCacheProvider.future);
      await cache.clear();
      state = const AuthSessionUnauthenticated();
    }
  }

  /// A token exists and the network just isn't reachable right now — the
  /// session is probably still valid, only unverifiable, so this falls back
  /// to the last-known identity instead of forcing a logout.
  Future<void> _fallBackToCachedMe() async {
    final cache = await ref.read(meCacheProvider.future);
    final cached = cache.read();
    state = cached != null
        ? AuthSessionAuthenticated(cached)
        : const AuthSessionUnauthenticated();
  }

  Future<void> _cacheMe(MeResult me) async {
    final cache = await ref.read(meCacheProvider.future);
    await cache.save(me);
  }

  Future<void> requestOtp(String phone) =>
      ref.read(authRepositoryProvider).requestOtp(phone);

  Future<void> verifyOtp({required String phone, required String code}) async {
    await ref.read(authRepositoryProvider).verifyOtp(phone: phone, code: code);
    await _checkExistingSession();
  }

  Future<void> emailLogin({
    required String email,
    required String password,
  }) async {
    await ref
        .read(authRepositoryProvider)
        .emailLogin(email: email, password: password);
    await _checkExistingSession();
  }

  /// Links a password to the *current* session — not a signup. Only valid
  /// while authenticated.
  Future<void> registerEmailPassword({
    required String email,
    required String password,
  }) {
    return ref
        .read(authRepositoryProvider)
        .registerEmailPassword(email: email, password: password);
  }

  /// Null means the Google picker was cancelled or failed before a token
  /// came back — nothing to show, not an error. A real rejection from the
  /// backend (not linked / already linked) still throws [AppException] for
  /// the caller to catch, same as every other auth method.
  Future<GoogleAuthResult?> googleSignIn({required bool link}) async {
    final idToken = await ref
        .read(googleSignInServiceProvider)
        .signInAndGetIdToken();
    if (idToken == null) return null;

    final result = await ref
        .read(authRepositoryProvider)
        .googleAuth(idToken: idToken, link: link);
    if (result is GoogleSignedIn) await _checkExistingSession();
    return result;
  }

  Future<void> updateProfile({
    String? displayName,
    String? avatarStorageKey,
  }) async {
    final me = await ref
        .read(authRepositoryProvider)
        .updateProfile(
          displayName: displayName,
          avatarStorageKey: avatarStorageKey,
        );
    await _cacheMe(me);
    state = AuthSessionAuthenticated(me);
  }

  Future<void> logout() async {
    await ref.read(authRepositoryProvider).logout();
    final cache = await ref.read(meCacheProvider.future);
    await cache.clear();
    state = const AuthSessionUnauthenticated();
  }
}
