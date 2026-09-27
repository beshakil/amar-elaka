import 'package:amar_elaka_app/core/design/tokens/app_typography.dart';
import 'package:flutter/services.dart';

/// Loads the app's real fonts into the test engine: without this, flutter
/// test draws every glyph as a box and a golden can't catch Bengali shaping
/// going wrong (broken conjuncts, detached vowel signs, clipped matras).
Future<void> loadAppFonts() async {
  await (FontLoader(appFontFamily)..addFont(
        rootBundle.load('assets/fonts/NotoSansBengali[wdth,wght].ttf'),
      ))
      .load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

/// Conjunct-heavy Bengali: ক্ষ, ঙ্ক্ষ, ষ্ট্র, স্ব, জ্জ্ব, ন্দ্র, র্ত্য, ক্ত, দ্ধ, reph (র্), ya-phala
/// and ra-phala — where shaping breaks first.
abstract final class ConjunctText {
  static const title =
      'সংক্ষিপ্ত ব্যবহৃত স্বাস্থ্যসম্মত রান্নাঘরের সরঞ্জাম — উজ্জ্বল কৃষ্ণচূড়া রঙ';
  static const brand = 'স্ট্র্যাটাস আকাঙ্ক্ষা';
  static const description =
      'রাষ্ট্রীয় স্বাস্থ্যকেন্দ্রের পাশে, মধ্যরাত্রিতেও নিরাপদ। বৈদ্যুতিক যন্ত্রাংশ অক্ষত, শুদ্ধ অবস্থায় আছে; '
      'প্রত্যেকটি জিনিস পরীক্ষিত। সন্ধ্যার পর যোগাযোগ করুন — ব্যক্তিগত বিক্রেতা, দালাল নয়।';
  static const place = 'ক্ষেত্রপাড়া, স্বাধীনতা সড়ক, চন্দ্রঘোনা';
  static const contact = 'মুক্তিযোদ্ধা শ্রীকৃষ্ণ দত্ত';
}
