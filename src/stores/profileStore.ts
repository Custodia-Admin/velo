/**
 * profileStore — the active rider's local profile: a stable id and a name.
 *
 * Persisted to localStorage exactly like settingsStore. No server, no auth.
 * riderRosterStore swaps the whole profile when the rider changes.
 *
 * Profiles saved by older builds also carry XP and lifetime totals; nothing
 * reads or updates them any more, and they ride along untouched.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { shortId } from '@/lib/utils';

export interface RiderProfile {
  /** Stable local identifier. */
  id: string;
  displayName: string;
  createdAt: number;
}

function makeProfile(name: string): RiderProfile {
  return {
    id: shortId(),
    displayName: name.trim() || 'Rider',
    createdAt: Date.now(),
  };
}

interface ProfileStoreState {
  profile: RiderProfile | null;

  /** Create a profile if none exists (idempotent — won't overwrite). */
  createProfile: (name: string) => void;
  /** Rename the active profile. */
  renameProfile: (name: string) => void;
}

export const useProfileStore = create<ProfileStoreState>()(
  persist(
    (set, get) => ({
      profile: null,

      createProfile: (name) => {
        if (get().profile) return; // never overwrite existing profile
        set({ profile: makeProfile(name) });
      },

      renameProfile: (name) => {
        const { profile } = get();
        if (!profile) return;
        set({ profile: { ...profile, displayName: name.trim() || 'Rider' } });
      },
    }),
    {
      name: 'globeride.profile.v1',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
);
