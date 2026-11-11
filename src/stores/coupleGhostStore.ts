/**
 * The couple ghost's settings and, during a ride, the ghost itself.
 *
 * `choice` (persisted) is what the rider picked on the setup step: the other
 * rider's last ride here, their best, or no ghost. `ghost` is the one the
 * world renderer loaded for the current ride (transient), read by the Finish
 * screen to compare the two rides.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { CoupleGhost, CoupleGhostChoice } from '@/lib/play/coupleGhost';

interface CoupleGhostState {
  choice: CoupleGhostChoice;
  ghost: CoupleGhost | null;
  setChoice: (choice: CoupleGhostChoice) => void;
  setGhost: (ghost: CoupleGhost | null) => void;
}

const CHOICES: readonly CoupleGhostChoice[] = ['last', 'best', 'off'];

export const useCoupleGhostStore = create<CoupleGhostState>()(
  persist(
    (set) => ({
      choice: 'last',
      ghost: null,
      setChoice: (choice) => set({ choice }),
      setGhost: (ghost) => set({ ghost }),
    }),
    {
      // 'globeride.' prefix so local backups (lib/dataBackup) include it.
      name: 'globeride.velo.coupleGhost.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ choice: s.choice }),
      merge: (persisted, current) => {
        const choice = (persisted as Partial<CoupleGhostState> | null)?.choice;
        return { ...current, choice: choice && CHOICES.includes(choice) ? choice : current.choice };
      },
    },
  ),
);
