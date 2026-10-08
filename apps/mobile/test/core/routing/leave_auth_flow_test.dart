import 'package:amar_elaka_app/core/routing/leave_auth_flow.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

/// After sign-in, back to what asked for it, past login and the code page
/// (popping into the code page crashed a signed-in app on a device).
void main() {
  late GoRouter router;
  // The app's router refreshes whenever auth state changes; saving the
  // profile changes it just before leaving.
  final refresh = ValueNotifier(0);

  Widget page(String name) => Builder(
    builder: (context) => Scaffold(
      body: Column(
        children: [
          Text('page $name'),
          TextButton(
            onPressed: () => leaveAuthFlow(context),
            child: const Text('done'),
          ),
          TextButton(
            // As "save": the profile update refreshes the router first.
            onPressed: () async {
              refresh.value++;
              await Future<void>.delayed(Duration.zero);
              if (context.mounted) leaveAuthFlow(context);
            },
            child: const Text('save'),
          ),
        ],
      ),
    ),
  );

  Future<void> pump(WidgetTester tester, String start) async {
    router = GoRouter(
      initialLocation: start,
      refreshListenable: refresh,
      redirect: (_, _) => null,
      routes: [
        GoRoute(path: RoutePaths.home, builder: (_, _) => page('home')),
        GoRoute(path: '/posts/:id', builder: (_, _) => page('post')),
        GoRoute(path: RoutePaths.login, builder: (_, _) => page('login')),
        GoRoute(path: RoutePaths.otpVerify, builder: (_, _) => page('otp')),
        GoRoute(
          path: RoutePaths.profileCompletion,
          builder: (_, _) => page('profile'),
        ),
      ],
    );
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
  }

  testWidgets('from a post through login, code and profile: back to the post', (
    tester,
  ) async {
    await pump(tester, '/posts/p1');
    for (final path in [
      RoutePaths.login,
      RoutePaths.otpVerify,
      RoutePaths.profileCompletion,
    ]) {
      router.push(path);
      await tester.pumpAndSettle();
    }
    expect(find.text('page profile'), findsOneWidget);

    await tester.tap(find.text('done'));
    await tester.pumpAndSettle();
    expect(find.text('page post'), findsOneWidget);
    expect(router.routerDelegate.currentConfiguration.uri.path, '/posts/p1');
  });

  testWidgets('sent to login with nothing behind it: home', (tester) async {
    await pump(tester, RoutePaths.login);
    router.push(RoutePaths.otpVerify);
    await tester.pumpAndSettle();
    router.push(RoutePaths.profileCompletion);
    await tester.pumpAndSettle();

    await tester.tap(find.text('done'));
    await tester.pumpAndSettle();
    expect(find.text('page home'), findsOneWidget);
  });

  testWidgets('after a refresh (the profile save), still back to the post', (
    tester,
  ) async {
    await pump(tester, '/posts/p1');
    for (final path in [
      RoutePaths.login,
      RoutePaths.otpVerify,
      RoutePaths.profileCompletion,
    ]) {
      router.push(path);
      await tester.pumpAndSettle();
    }
    await tester.tap(find.text('save'));
    await tester.pumpAndSettle();
    expect(find.text('page post'), findsOneWidget);
  });
}
