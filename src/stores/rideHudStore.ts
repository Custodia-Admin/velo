/**
 * In-ride HUD layout state (compact ride HUD, owner-directed revision 2 Nov
 * 2026, docs/design/mockups/v2-ride-hud.html).
 *
 * `expanded`: the ride details (route card + profile + weather, minimap,
 * ride tools) are open above the ride band. Collapsed by default and
 * persisted, so the HUD comes back the way the rider left it.
 *
 * `devicesOpen`: the in-ride devices sheet the status chip opens. Per ride,
 * never persisted.
 *
 * `noticeHosts`: how many ride status chips are mounted. While one is, the
 * app Toaster draws nothing and the chip shows each toast instead (one
 * small pill, never a large red box over the ride).
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export const RIDE_HUD_STORAGE_KEY = 'velo.rideHud.v1';

interface RideHudState {
  expanded: boolean;
  devicesOpen: boolean;
  noticeHosts: number;
  setExpanded: (open: boolean) => void;
  toggleExpanded: () => void;
  setDevicesOpen: (open: boolean) => void;
  /** Register a status chip as the toast host; returns the release. */
  hostNotices: () => () => void;
}

export const useRideHudStore = create<RideHudState>()(
  persist(
    (set) => ({
      expanded: false,
      devicesOpen: false,
      noticeHosts: 0,
      setExpanded: (open) => set({ expanded: open }),
      toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
      setDevicesOpen: (open) => set({ devicesOpen: open }),
      hostNotices: () => {
        set((s) => ({ noticeHosts: s.noticeHosts + 1 }));
        let released = false;
        return () => {
          if (released) return;
          released = true;
          set((s) => ({ noticeHosts: Math.max(0, s.noticeHosts - 1) }));
        };
      },
    }),
    {
      name: RIDE_HUD_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (s) => ({ expanded: s.expanded }),
    },
  ),
);
