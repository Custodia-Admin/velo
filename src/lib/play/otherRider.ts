/**
 * The other rider in the household roster (two riders share one trainer),
 * in their own colours, never identical to the active rider's. The Cesium
 * play layer's riding buddy and the couple ghost both ride in them.
 *
 * Reads the roster and settings stores; no renderer imports, so the world
 * renderer can use it without pulling Cesium in.
 */

import { AVATAR_PRESETS, type AvatarColors } from '@/lib/avatarConfig';
import { useRiderRosterStore } from '@/stores/riderRosterStore';
import { useSettingsStore } from '@/stores/settingsStore';

export interface OtherRider {
  id: string;
  name: string;
  colors: AvatarColors;
}

const sameColors = (a: AvatarColors, b: AvatarColors) => JSON.stringify(a) === JSON.stringify(b);

/** The roster rider who isn't riding now, or null with a one-rider roster. */
export function otherRider(): OtherRider | null {
  const { riders, activeRiderId } = useRiderRosterStore.getState();
  const other = riders.find((r) => r.id !== activeRiderId);
  if (!other) return null;
  const mine = useSettingsStore.getState().avatar;
  let colors = other.settings?.avatar ?? AVATAR_PRESETS[0].colors;
  if (sameColors(colors, mine)) {
    colors = (AVATAR_PRESETS.find((p) => !sameColors(p.colors, mine)) ?? AVATAR_PRESETS[1]).colors;
  }
  return { id: other.id, name: other.name, colors };
}
