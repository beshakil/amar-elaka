import { OG_TEXT } from '../../seo/og-image/og-image.templates';

/** The counter card's Bengali (rule 6): what a customer at the counter reads. */
export const COUNTER_TEXT = {
  brand: (tenantName: string) => `${OG_TEXT.brand} · ${tenantName}`,
  lead: 'ক্যামেরায় স্ক্যান করে পণ্য দেখুন, WhatsApp-এ অর্ডার করুন',
  stickerLead: 'স্ক্যান করে অর্ডার করুন',
  hint: 'ফোনের ক্যামেরা কোডটির দিকে ধরুন — লিংক খুলে যাবে',
  filename: (slug: string, size: string) => `counter-card-${slug}-${size}.pdf`,
} as const;
