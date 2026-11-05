/**
 * Map & terrain credits (Home footer): which data sources to credit, as pure
 * functions over the destination manifests. Every entry is a manifest's own
 * `credits[]` item, so a world baked from a new source (e.g. Copernicus
 * GLO-30, whose licence requires its notice and liability sentence wherever
 * the data is shown) is credited with no code change.
 */
import type { Destination } from '@/lib/world/destinations';
import type { WorldCredit } from '@/lib/world/manifest';

export interface CreditEntry {
  /** React key: the credit id (plus a counter if one id carries two texts). */
  key: string;
  credit: WorldCredit;
  /** Names of the destinations that carry this credit, in Home order. */
  places: string[];
}

/**
 * The credits of every destination, deduplicated by id, in first-seen order
 * (Home order: home, hometown, wishlist). An id that comes with different
 * text in two manifests stays two entries, so no licence text is dropped.
 */
export function worldCredits(destinations: readonly Destination[]): CreditEntry[] {
  const out: CreditEntry[] = [];
  const byText = new Map<string, CreditEntry>();
  const perId = new Map<string, number>();
  for (const d of destinations) {
    for (const credit of d.credits) {
      const text = JSON.stringify([credit.id, credit.name, credit.attribution, credit.licence, credit.url]);
      let entry = byText.get(text);
      if (!entry) {
        const n = perId.get(credit.id) ?? 0;
        perId.set(credit.id, n + 1);
        entry = { key: n === 0 ? credit.id : `${credit.id}-${n + 1}`, credit, places: [] };
        byText.set(text, entry);
        out.push(entry);
      }
      if (!entry.places.includes(d.name)) entry.places.push(d.name);
    }
  }
  return out;
}

/** "Used for every place", "Used for Lugano", "Used for Perugia and Lugano". */
export function creditPlaces(places: readonly string[], total: number): string {
  if (total > 1 && places.length === total) return 'Used for every place';
  if (places.length <= 1) return `Used for ${places[0] ?? ''}`.trim();
  return `Used for ${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}`;
}
