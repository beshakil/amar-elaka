# Amar Elaka — Flutter client

Client shell: navigation, theming, auth screens, tenant bootstrap. See
`docs/decisions/002-mobile-app-architecture.md` for the architecture and the
non-obvious decisions behind it.

## Setup

```
flutter pub get
dart run build_runner build --delete-conflicting-outputs   # riverpod + drift codegen
flutter gen-l10n                                            # lib/l10n/app_localizations*.dart
```

`apps/api` must be running for anything beyond the design-system screen to work
(`make up && pnpm --filter api dev` from the repo root).

## Running against the local API

VS Code's Run and Debug has a configuration per device (`.vscode/launch.json`
at the repo root, and `apps/mobile/.vscode/launch.json` for opening this folder
alone):

| Configuration      | API_BASE_URL                        | Needs                                    |
| ------------------ | ----------------------------------- | ---------------------------------------- |
| Emulator           | `http://10.0.2.2:3000/api/v1`       | nothing (10.0.2.2 is the PC's localhost) |
| Phone (USB)        | `http://localhost:3000/api/v1`      | USB debugging; `adb reverse` runs first  |
| Phone (WiFi)       | `http://<PC's WiFi IP>:3000/api/v1` | same WiFi, and the WSL setup below       |
| Emulator (profile) | as Emulator                         | profile mode, for performance checks     |

From a terminal, the same with `flutter run --dart-define=API_BASE_URL=...`.

**Prefer USB for a real phone.** `adb reverse tcp:3000 tcp:3000` makes the
phone's `localhost:3000` the PC's, and Windows already forwards `localhost`
into WSL, so there's no IP, firewall or WSL setup.

**WiFi needs the API reachable from the LAN.** The API runs in WSL 2, which by
default sits behind NAT: the phone can't reach it on the PC's IP. Once, on
Windows (Windows 11 22H2+):

1. Create `%UserProfile%\.wslconfig` with
   ```
   [wsl2]
   networkingMode=mirrored
   ```
2. `wsl --shutdown` (PowerShell), then reopen WSL and start the API again.
3. Allow the port (PowerShell as Administrator):
   `New-NetFirewallRule -DisplayName "Amar Elaka API 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -Profile Private`
4. `ipconfig` → Wireless LAN adapter Wi-Fi → IPv4 Address is what Phone (WiFi)
   asks for. On the phone, `http://<that IP>:3000/health/live` in a browser
   should answer before you launch.

**Maps** are OpenStreetMap tiles, free and keyless, in every build
(`lib/core/map/map_config.dart`, ADR 033). Keep the attribution on every map.

## Post flows: tests

`flutter test` covers every step, my posts, drafts and error messages, the
full happy path headless, and golden images of the post card and preview in
Bengali (regenerate on Linux: `flutter test --update-goldens
test/features/post/goldens`). On an emulator or phone:
`flutter test integration_test/post_happy_path_test.dart`. The low-RAM
checklist for the photo step is in docs/decisions/032-mobile-post-flows.md.

Plain `http://` works in debug and profile builds only
(`android:usesCleartextTraffic` in `android/app/src/{debug,profile}`); release
builds need HTTPS.

## Debug-only screens

`/design-system` (every design token and base widget, both themes) only
exists in debug builds — `kDebugMode` gates its route registration in
`lib/core/routing/app_router.dart`, so it's tree-shaken out of release.

## Release builds (Android)

Release builds are signed with the Play upload key, which is never committed
(`android/.gitignore` ignores `key.properties`, `*.jks` and `*.keystore`).

1. Create the upload key once, and keep it (and its passwords) in the team's
   password manager. Losing it means asking Google for an upload key reset:

   ```sh
   keytool -genkey -v -keystore ~/amar-elaka-upload.jks -keyalg RSA \
     -keysize 2048 -validity 10000 -alias upload
   ```

2. On a developer machine, `android/key.properties`:

   ```properties
   storeFile=/home/you/amar-elaka-upload.jks
   storePassword=…
   keyAlias=upload
   keyPassword=…
   ```

   In CI, the same four values as `ANDROID_KEYSTORE_FILE`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.

3. Build: `flutter build appbundle --release --dart-define=API_BASE_URL=https://…`.
   Without a key, `bundleRelease` stops with an error instead of producing a
   debug-signed bundle the Play Store could never update; `flutter run
--release` on a test phone still works with the debug key.

The application id `com.amarelaka.amar_elaka_app` is the app's Play Store
identity and can't change after the first upload.
