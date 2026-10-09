/** The ways to reach a store (ADR 054): its phone takes calls and SMS, its WhatsApp number WhatsApp. */
export const STORE_CONTACT_CHANNELS = ['call', 'whatsapp', 'sms'] as const;
export type StoreContactChannel = (typeof STORE_CONTACT_CHANNELS)[number];

/** The number a channel reaches, or null when the store hasn't given one. */
export function storeNumberFor(
  channel: StoreContactChannel,
  store: { phone_e164: string | null; whatsapp_e164: string | null },
): string | null {
  return channel === 'whatsapp' ? store.whatsapp_e164 : store.phone_e164;
}

/** Which channels the store page may offer — never the numbers themselves. */
export function storeChannels(store: {
  phone_e164: string | null;
  whatsapp_e164: string | null;
}): StoreContactChannel[] {
  return STORE_CONTACT_CHANNELS.filter((channel) => storeNumberFor(channel, store) !== null);
}
