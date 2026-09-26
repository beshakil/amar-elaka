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

Plain `http://` works in debug and profile builds only
(`android:usesCleartextTraffic` in `android/app/src/{debug,profile}`); release
builds need HTTPS.

## Debug-only screens

`/design-system` (every design token and base widget, both themes) only
exists in debug builds — `kDebugMode` gates its route registration in
`lib/core/routing/app_router.dart`, so it's tree-shaken out of release.
