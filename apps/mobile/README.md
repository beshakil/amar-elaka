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
(`make up && pnpm --filter api dev` from the repo root). The default API base
URL targets the Android emulator's host alias; override for a physical device
or a different port with:

```
flutter run --dart-define=API_BASE_URL=http://<host>:3000/api/v1
```

## Debug-only screens

`/design-system` (every design token and base widget, both themes) only
exists in debug builds — `kDebugMode` gates its route registration in
`lib/core/routing/app_router.dart`, so it's tree-shaken out of release.
