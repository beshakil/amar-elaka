import { bengaliNumber } from '../../common/text/bengali-numerals';

/**
 * rule 6: the one place a bulk import's words live — the template's headers
 * and example row, and the per-row reasons in the report a seller downloads.
 * Bengali (the platform default); the reason codes beside them are stable for
 * clients that word reasons themselves.
 */
export const IMPORT_TEXT = {
  title: 'শিরোনাম',
  titleEn: 'Title',
  description: 'বিবরণ',
  descriptionEn: 'Description',
  yes: 'হ্যাঁ',
  exampleTitle: 'স্যামসাং গ্যালাক্সি A15, ১২৮ জিবি',
  exampleDescription: 'নতুন, বক্সসহ। ১ বছরের ওয়ারেন্টি।',
  exampleText: 'স্যামসাং',
  exampleTextarea: 'সংক্ষেপে লিখুন',
  examplePhone: '01712345678',
  exampleMoney: '1500.00',
  exampleDate: '2026-12-31',
  exampleImageUrl: 'https://example.com/photo-1.jpg',
  sheetName: 'পণ্য',
  // The report.
  reportHeader: ['সারি', 'ফলাফল', 'কারণের কোড', 'কারণ', 'পোস্ট'],
  outcome: {
    created: 'তৈরি হয়েছে',
    valid: 'ঠিক আছে (পরীক্ষা)',
    skipped: 'বাদ দেওয়া হয়েছে',
    failed: 'ব্যর্থ',
  },
  missingTitle: 'শিরোনাম নেই',
  blankRow: 'ফাঁকা সারি',
  duplicateTitle: 'এই দোকানে একই শিরোনামের পোস্ট আগে থেকেই আছে',
  unknownOption: (cell: string, options: string[]) =>
    `"${cell}" তালিকায় নেই; লিখুন: ${options.join(', ')}`,
  invalidMoney: (cell: string) => `"${cell}" টাকার অঙ্ক নয় (যেমন 1500 বা 1500.50)`,
  invalidNumber: (cell: string) => `"${cell}" সংখ্যা নয়`,
  invalidYesNo: (cell: string) => `"${cell}" — হ্যাঁ বা না লিখুন`,
  invalidDate: (cell: string) => `"${cell}" তারিখ নয় (যেমন 2026-12-31)`,
  imageMissingInZip: (name: string) => `"${name}" ছবিটি ZIP ফাইলে পাওয়া যায়নি`,
  imageNoZip: (name: string) => `"${name}" ছবির জন্য ZIP ফাইল দেওয়া হয়নি`,
  imageUrlInvalid: (url: string) => `"${url}" বৈধ http(s) লিংক নয়`,
  imageUrlBlocked: (url: string) => `"${url}" লিংকটি খোলা যাবে না (ভেতরের ঠিকানা)`,
  imageFetchFailed: (url: string) => `"${url}" থেকে ছবি আনা যায়নি`,
  imageTooLarge: (name: string) => `"${name}" ছবিটি খুব বড়`,
  imageRejected: (name: string) => `"${name}" ছবি হিসেবে পড়া যায়নি (JPEG, PNG বা WebP দিন)`,
  tooManyImages: (max: number) => `একটি পোস্টে সর্বোচ্চ ${bengaliNumber(max)}টি ছবি`,
} as const;

export const imageHeader = (n: number) => `ছবি ${bengaliNumber(n)}`;
