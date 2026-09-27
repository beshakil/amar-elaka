import type { ContactChannel } from './dto/engagement.dto';

/** The lead_channels code (0009) each reveal is recorded under. */
export const LEAD_CHANNEL: Record<ContactChannel, 'call_click' | 'whatsapp_click' | 'sms_click'> = {
  call: 'call_click',
  whatsapp: 'whatsapp_click',
  sms: 'sms_click',
};

/** The channels a post offers: calls and SMS with showPhone, WhatsApp also needs showWhatsapp. */
export function offeredChannels(post: {
  hasPhone: boolean;
  showPhone: boolean;
  showWhatsapp: boolean;
}): ContactChannel[] {
  if (!post.hasPhone || !post.showPhone) return [];
  return post.showWhatsapp ? ['call', 'whatsapp', 'sms'] : ['call', 'sms'];
}

/**
 * What the client opens. `phone` is E.164 (+8801…): tel: and sms: take it
 * as is, wa.me wants the digits without the plus.
 */
export function contactHref(channel: ContactChannel, phone: string, message: string): string {
  switch (channel) {
    case 'call':
      return `tel:${phone}`;
    case 'sms':
      return `sms:${phone}?body=${encodeURIComponent(message)}`;
    case 'whatsapp':
      return `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`;
  }
}
