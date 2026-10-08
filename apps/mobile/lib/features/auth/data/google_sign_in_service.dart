import 'package:google_sign_in/google_sign_in.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../core/network/api_exception.dart';

import 'google_auth_config.dart';

part 'google_sign_in_service.g.dart';

/// Thin wrapper around `google_sign_in`'s v7 API
/// (`GoogleSignIn.instance.initialize()` once, then `.authenticate()` per
/// attempt). Null when the user cancels; any other failure is a
/// [GoogleSignInFailedException] the login screen words, never a raw plugin
/// exception.
class GoogleSignInService {
  bool _initialized = false;

  Future<String?> signInAndGetIdToken() async {
    try {
      if (!_initialized) {
        await GoogleSignIn.instance.initialize(
          clientId: GoogleAuthConfig.clientId.isEmpty
              ? null
              : GoogleAuthConfig.clientId,
          serverClientId: GoogleAuthConfig.serverClientId.isEmpty
              ? null
              : GoogleAuthConfig.serverClientId,
        );
        _initialized = true;
      }
      final account = await GoogleSignIn.instance.authenticate();
      return account.authentication.idToken;
    } on GoogleSignInException catch (e) {
      if (e.code == GoogleSignInExceptionCode.canceled) return null;
      throw const GoogleSignInFailedException();
    } on Object {
      throw const GoogleSignInFailedException();
    }
  }
}

@riverpod
GoogleSignInService googleSignInService(Ref ref) => GoogleSignInService();
