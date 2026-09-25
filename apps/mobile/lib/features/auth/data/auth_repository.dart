import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors/auth_interceptor.dart';
import '../../../core/storage/secure_session_storage.dart';
import '../domain/google_auth_result.dart';
import 'device_info.dart';

part 'auth_repository.g.dart';

final _noAuth = Options(extra: {skipAuthKey: true});

/// Auth endpoints (apps/api/src/auth/auth.controller.ts). Every method
/// throws [AppException] (never a raw `DioException`) and persists the
/// resulting session itself — callers don't touch `SecureSessionStorage`
/// for tokens directly.
class AuthRepository {
  AuthRepository(this._dio, this._storage);

  final Dio _dio;
  final SecureSessionStorage _storage;

  /// Returns how long until the server accepts another request for [phone].
  Future<Duration> requestOtp(String phone) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/otp/request',
        data: OtpRequestBody(phone: phone).toJson(),
        options: _noAuth,
      );
      final sent = OtpSent.fromJson(response.data!);
      return Duration(seconds: sent.resendAfterSeconds);
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  Future<void> verifyOtp({required String phone, required String code}) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/otp/verify',
        data: OtpVerifyBody(
          phone: phone,
          code: code,
          device: currentDevice(),
        ).toJson(),
        options: _noAuth,
      );
      await _saveSession(SessionTokens.fromJson(response.data!));
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  Future<void> emailLogin({
    required String email,
    required String password,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/email/login',
        data: EmailLoginRequest(
          email: email,
          password: password,
          device: currentDevice(),
        ).toJson(),
        options: _noAuth,
      );
      await _saveSession(SessionTokens.fromJson(response.data!));
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  /// Links a password to the caller's own (already-authenticated) account —
  /// not a signup; needs a real session, doesn't start one.
  Future<void> registerEmailPassword({
    required String email,
    required String password,
  }) async {
    try {
      await _dio.post<void>(
        '/auth/email/register',
        data: EmailRegisterRequest(email: email, password: password).toJson(),
      );
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  /// `link: false` — unauthenticated sign-in with an already-linked Google
  /// account (never creates one). `link: true` — authenticated, links
  /// Google to the caller's own account.
  Future<GoogleAuthResult> googleAuth({
    required String idToken,
    required bool link,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/google',
        data: GoogleAuthRequest(
          idToken: idToken,
          device: currentDevice(),
        ).toJson(),
        options: link ? null : _noAuth,
      );
      final data = response.data!;
      if (data.containsKey('linked')) return const GoogleLinked();

      final tokens = SessionTokens.fromJson(data);
      await _saveSession(tokens);
      return GoogleSignedIn(tokens);
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  Future<MeResult> me() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/auth/me');
      return MeResult.fromJson(response.data!);
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  Future<MeResult> updateProfile({
    String? displayName,
    String? avatarStorageKey,
  }) async {
    try {
      final response = await _dio.patch<Map<String, dynamic>>(
        '/auth/me',
        data: UpdateProfileRequest(
          displayName: displayName,
          avatarStorageKey: avatarStorageKey,
        ).toJson(),
      );
      return MeResult.fromJson(response.data!);
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  Future<void> logout() async {
    final refreshToken = await _storage.readRefreshToken();
    if (refreshToken != null) {
      try {
        await _dio.post<void>(
          '/auth/logout',
          data: RefreshRequestBody(refreshToken: refreshToken).toJson(),
        );
      } on DioException {
        // Best-effort: the token is deleted locally regardless, so a failed
        // server-side revoke doesn't strand the user in a logged-in UI.
      }
    }
    await _storage.clearSession();
  }

  Future<void> _saveSession(SessionTokens tokens) {
    return _storage.saveSession(
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    );
  }
}

@riverpod
AuthRepository authRepository(Ref ref) {
  return AuthRepository(
    ref.watch(dioClientProvider),
    ref.watch(secureSessionStorageProvider),
  );
}
