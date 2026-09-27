import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:amar_elaka_app/features/post/presentation/widgets/post_card.dart';
import 'package:amar_elaka_app/features/post/presentation/widgets/post_detail_view.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

void main() {
  testWidgets('shows the card and the detail page as buyers will see them', (
    tester,
  ) async {
    await pumpPostApp(tester);
    await walkTo(tester, PostStep.preview);
    expect(find.text('ধাপ ৬/৬: দেখে নিন'), findsOneWidget);
    expect(find.byType(PostCard), findsOneWidget);
    expect(find.byType(PostDetailView), findsOneWidget);
    expect(find.text('আইফোন ১৩ বিক্রি'), findsNWidgets(2));
    expect(find.text('৳ ৬৫,০০০'), findsNWidgets(2)); // grouped, Bengali digits
    expect(find.text('অবস্থা ব্যবহৃত'), findsOneWidget); // the card's key fact
    expect(find.text('মিরপুর ১০, ঢাকা · আজ'), findsWidgets);
    expect(find.text('০১৭১২৩৪৫৬৭৮'), findsOneWidget);
    expect(find.text('পোস্ট করুন'), findsOneWidget);
  });
}
