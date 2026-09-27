import 'package:flutter/material.dart';

import '../../feed/presentation/feed_screen.dart';

/// The home tab: the feed. `AppShell` provides the shared app bar and
/// bottom nav; this is body content only.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) => const FeedScreen();
}
