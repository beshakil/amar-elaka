/**
 * The mixed feed's page layout (ADR 035), pure so it is unit-tested alone:
 *  - a store card after every `storeInterval` post cards, counted across
 *    pages (`postsBefore`), so page 2 keeps page 1's rhythm;
 *  - on the first page only, info cards (emergency shortcut, bazar prices,
 *    landmarks) at their configured 1-based slots of the final list.
 * An interval or position of 0 means off.
 */

export interface InfoSlot<T> {
  /** 1-based slot in the final page; past the end appends. */
  position: number;
  cards: readonly T[];
}

/** Store cards the posts of this page call for. */
export function storeSlotsFor(
  postsBefore: number,
  postCount: number,
  storeInterval: number,
): number {
  if (storeInterval <= 0) return 0;
  return (
    Math.floor((postsBefore + postCount) / storeInterval) - Math.floor(postsBefore / storeInterval)
  );
}

export function layoutFeedPage<P, S, I>(input: {
  posts: readonly P[];
  stores: readonly S[];
  postsBefore: number;
  storeInterval: number;
  info: readonly InfoSlot<I>[];
}): { items: (P | S | I)[]; storesUsed: number } {
  const items: (P | S | I)[] = [];
  let storesUsed = 0;
  input.posts.forEach((post, index) => {
    items.push(post);
    const shown = input.postsBefore + index + 1;
    if (
      input.storeInterval > 0 &&
      shown % input.storeInterval === 0 &&
      storesUsed < input.stores.length
    ) {
      items.push(input.stores[storesUsed]!);
      storesUsed += 1;
    }
  });

  const slots = input.info
    .filter((slot) => slot.position > 0 && slot.cards.length > 0)
    .sort((a, b) => a.position - b.position);
  for (const slot of slots) {
    items.splice(Math.min(slot.position - 1, items.length), 0, ...slot.cards);
  }
  return { items, storesUsed };
}
