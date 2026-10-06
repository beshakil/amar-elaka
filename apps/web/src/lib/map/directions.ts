/**
 * Directions hand-off (ADR 046): Google Maps with the destination's
 * coordinates — the app on phones that have it (Android opens google.com/maps
 * links in it), the website elsewhere. No turn-by-turn here.
 */
export function directionsUrl(lat: number, lng: number): string {
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', `${lat},${lng}`);
  return url.toString();
}
