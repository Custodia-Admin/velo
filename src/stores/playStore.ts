/**
 * Live Play mode state for the HUD: postcard count and the buddy line.
 *
 * Written by the Cesium play layer, read by PlayPanel and the finish card.
 * Transient: nothing here is persisted. The on/off switch itself is the
 * per-rider `playMode` setting.
 */

import { create } from 'zustand';

export interface PlayState {
  /** True while a play layer is mounted on the current route. */
  active: boolean;
  total: number;
  collected: number;
  /** Metres to the next postcard, or null when all are collected. */
  toNextM: number | null;
  /** performance.now() of the last pickup, or 0. Drives the brief note. */
  lastPickupAt: number;
  /** One-line buddy status, or null when there's no buddy. */
  buddyLine: string | null;

  start: (total: number, buddyLine: string | null) => void;
  progress: (collected: number, toNextM: number | null, pickedUp: boolean) => void;
  setBuddyLine: (line: string | null) => void;
  /** Layer gone (route change, toggle off). Keeps the last count for the finish card. */
  stop: () => void;
  reset: () => void;
}

const INITIAL = {
  active: false,
  total: 0,
  collected: 0,
  toNextM: null,
  lastPickupAt: 0,
  buddyLine: null,
} satisfies Partial<PlayState>;

export const usePlayStore = create<PlayState>()((set) => ({
  ...INITIAL,
  start: (total, buddyLine) =>
    set({ ...INITIAL, active: true, total, buddyLine }),
  progress: (collected, toNextM, pickedUp) =>
    set((s) => ({
      collected,
      toNextM,
      lastPickupAt: pickedUp ? performance.now() : s.lastPickupAt,
    })),
  setBuddyLine: (buddyLine) => set({ buddyLine }),
  stop: () => set({ active: false }),
  reset: () => set({ ...INITIAL }),
}));
