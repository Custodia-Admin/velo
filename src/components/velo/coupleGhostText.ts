/**
 * Words for the couple ghost and the postcards (pure, tested): the setup
 * step's ghost tiles and subtitle, the Finish screen's comparison and
 * postcards lines.
 */

import type { CoupleGhostChoice, CoupleGhostOptions, GhostVerdict } from '@/lib/play/coupleGhost';
import type { RideRecord } from '@/lib/rideHistory';
import { formatDuration } from '@/lib/utils';
import type { UnitSystem } from '@/stores/settingsStore';

/** "3 Nov". */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export interface GhostTile {
  choice: CoupleGhostChoice;
  title: string;
  meta: string;
}

const rideMeta = (r: Pick<RideRecord, 'startedAt' | 'durationSec'>) => `${shortDate(r.startedAt)} · ${formatDuration(r.durationSec)}`;

/**
 * The tiles to offer: their last ride, their best when it is a different
 * ride, and no ghost. Empty when they have no ride here.
 */
export function ghostTiles(options: CoupleGhostOptions, name: string): GhostTile[] {
  if (!options.last) return [];
  const tiles: GhostTile[] = [{ choice: 'last', title: 'Last ride', meta: rideMeta(options.last) }];
  if (options.best && options.best.id !== options.last.id) tiles.push({ choice: 'best', title: 'Best ride', meta: rideMeta(options.best) });
  tiles.push({ choice: 'off', title: 'No ghost', meta: `Ride without ${name}` });
  return tiles;
}

/** Which tile shows as picked: "best" is the last ride when that is also the best. */
export function pickedTile(tiles: readonly GhostTile[], choice: CoupleGhostChoice): CoupleGhostChoice {
  return tiles.some((t) => t.choice === choice) ? choice : 'last';
}

/** Step 3's collapsed line: who rides with you. */
export function rideWithSubtitle(ghostName: string | null, partnerNames: string): string {
  if (ghostName && partnerNames) return `${ghostName}'s ghost · with ${partnerNames}`;
  if (ghostName) return `${ghostName}'s ghost`;
  if (partnerNames) return `With ${partnerNames}`;
  return 'Riding alone';
}

const place = (m: number, units: UnitSystem) =>
  units === 'imperial' ? `${(m / 1609.344).toFixed(1)} mi` : `${(m / 1000).toFixed(1)} km`;

/**
 * The Finish line comparing the ride with the ghost: the figure (strong) and
 * the rest, e.g. "1:12 ahead" + " of Anna's last ride (3 Nov)".
 */
export function verdictLine(
  verdict: GhostVerdict,
  ghost: { riderName: string; kind: 'last' | 'best'; startedAt: number },
  units: UnitSystem,
): { strong: string; rest: string; lead: string } {
  const ride = `${ghost.riderName}'s ${ghost.kind} ride (${shortDate(ghost.startedAt)})`;
  const lead = verdict.finished ? '' : `At ${place(verdict.atM, units)}: `;
  switch (verdict.kind) {
    case 'ahead':
      return { lead, strong: `${formatDuration(verdict.seconds)} ahead`, rest: ` of ${ride}` };
    case 'behind':
      return { lead, strong: `${formatDuration(verdict.seconds)} behind`, rest: ` ${ride}` };
    case 'level':
      return { lead, strong: 'Level', rest: ` with ${ride}` };
    case 'further':
      return { lead: '', strong: 'Further', rest: ` than ${ride}` };
  }
}

/**
 * Longest run of place names on the Finish line, characters: names that
 * would run past it (in route order, longer ones skipped) become "and N more".
 */
export const PLACES_MAX_CHARS = 48;

/** "3 of 7 postcards found" and, when any were collected, their places: "Lugano, Paradiso and 1 more". */
export function postcardsLine(collected: number, total: number, names: readonly string[]): { count: string; places: string } {
  const count = `${collected} of ${total} postcards found`;
  const got = names.slice(0, collected);
  if (got.length === 0) return { count, places: '' };
  const shown: string[] = [];
  let len = 0;
  for (const n of got) {
    const add = (shown.length > 0 ? 2 : 0) + n.length;
    if (shown.length > 0 && len + add > PLACES_MAX_CHARS) continue;
    shown.push(n);
    len += add;
  }
  const more = got.length - shown.length;
  return { count, places: more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ') };
}
