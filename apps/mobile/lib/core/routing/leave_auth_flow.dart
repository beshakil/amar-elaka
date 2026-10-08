import 'package:flutter/widgets.dart';
import 'package:flutter/scheduler.dart';
import 'package:go_router/go_router.dart';

import 'redirect_logic.dart' show authRoutes;
import 'route_paths.dart';

/// Screens that only make sense while signing in.
const _authFlow = {...authRoutes, RoutePaths.profileCompletion};

/// After sign-in (profile saved or skipped): back to the screen that asked
/// for it — the post someone wanted to save, say — past the login and code
/// pages, in one step. Popping one page at a time would land on the code
/// page again, which a signed-in router can't rebuild (found on a device).
/// With nothing to go back to (a guest sent to login), home.
///
/// Waits a frame first: signing in or saving the profile changes auth state,
/// which refreshes the router, and a refresh that lands after these pops
/// re-applies the stack as it was, undoing them (found on a device: "save"
/// stayed on the profile page while "not now" left).
Future<void> leaveAuthFlow(BuildContext context) async {
  final router = GoRouter.of(context);
  await SchedulerBinding.instance.endOfFrame;
  // Counted first: the stack is only re-read after a frame, so popping while
  // checking the top would keep seeing the page just popped.
  final pages = router.routerDelegate.currentConfiguration.matches
      .map((m) => m.matchedLocation)
      .toList();
  var inFlow = 0;
  while (inFlow < pages.length &&
      _authFlow.contains(pages[pages.length - 1 - inFlow])) {
    inFlow++;
  }
  if (inFlow == pages.length) {
    router.go(RoutePaths.home);
    return;
  }
  for (var i = 0; i < inFlow; i++) {
    router.pop();
  }
}
