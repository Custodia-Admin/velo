/**
 * Show mode state: watch your own videos while the ride rolls on, or float
 * the ride over another tab (journey mode, a Document Picture-in-Picture
 * window; lib/show/pip.ts).
 *
 * Only the panel size and the floating window's size are persisted.
 * Everything else is per ride: object URLs are revoked when show mode ends,
 * and the auto camera (the cinematic director) starts fresh each time.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { fileKey, sortForPlayback, titleFromFileName } from '@/lib/show/showLibrary';
import { isPipSize, type PipSize } from '@/lib/show/pip';

export type ShowSize = 's' | 'm' | 'l';
/** Where the show is: nothing chosen yet, local files, or a PiP window elsewhere. */
export type ShowSource = 'none' | 'files' | 'pip';

export interface ShowItem {
  key: string;
  title: string;
  url: string;
}

export const SHOW_SIZES: ReadonlyArray<ShowSize> = ['s', 'm', 'l'];

interface ShowState {
  /** Show mode is on: auto camera runs and the HUD gets out of the way. */
  active: boolean;
  /** The video panel is on screen (false while using picture-in-picture). */
  panelOpen: boolean;
  source: ShowSource;
  items: ShowItem[];
  index: number;
  playing: boolean;
  /** performance.now() when show mode started; drives the auto camera. */
  startedAtMs: number | null;
  autoCamera: boolean;
  size: ShowSize;
  /** The ride is floating in a picture-in-picture window (journey mode). */
  pipOpen: boolean;
  /** Size of the floating window (persisted). */
  pipSize: PipSize;

  startShow: (nowMs?: number) => void;
  endShow: () => void;
  /** Load videos in playback order; `startKey` picks the one to start with (default the first). */
  loadFiles: (files: File[], opts?: { startKey?: string }) => void;
  usePip: () => void;
  openPanel: () => void;
  setIndex: (index: number) => void;
  /** Advance to the next video. Returns false at the end of the list. */
  next: () => boolean;
  setPlaying: (playing: boolean) => void;
  setSize: (size: ShowSize) => void;
  setAutoCamera: (on: boolean) => void;
  setPipOpen: (open: boolean) => void;
  setPipSize: (size: PipSize) => void;
}

function revokeAll(items: ShowItem[]): void {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  for (const it of items) URL.revokeObjectURL(it.url);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export const useShowStore = create<ShowState>()(
  persist(
    (set, get) => ({
      active: false,
      panelOpen: false,
      source: 'none',
      items: [],
      index: 0,
      playing: false,
      startedAtMs: null,
      autoCamera: true,
      size: 'm',
      pipOpen: false,
      pipSize: 'corner',

      startShow: (nowMs = now()) =>
        set((s) => ({
          active: true,
          panelOpen: true,
          autoCamera: s.active ? s.autoCamera : true,
          startedAtMs: s.active && s.startedAtMs !== null ? s.startedAtMs : nowMs,
        })),

      endShow: () => {
        revokeAll(get().items);
        set({
          active: false,
          panelOpen: false,
          source: 'none',
          items: [],
          index: 0,
          playing: false,
          startedAtMs: null,
          autoCamera: true,
        });
      },

      loadFiles: (files, opts) => {
        if (files.length === 0) return;
        revokeAll(get().items);
        const items = sortForPlayback(files).map((f) => ({
          key: fileKey(f),
          title: titleFromFileName(f.name),
          url: URL.createObjectURL(f),
        }));
        const at = opts?.startKey ? items.findIndex((it) => it.key === opts.startKey) : 0;
        set({ items, index: Math.max(0, at), source: 'files', panelOpen: true, playing: false });
      },

      usePip: () => {
        revokeAll(get().items);
        set({ source: 'pip', panelOpen: false, items: [], index: 0, playing: false });
      },

      openPanel: () => set({ panelOpen: true }),

      setIndex: (index) => {
        const { items } = get();
        if (index < 0 || index >= items.length) return;
        set({ index });
      },

      next: () => {
        const { index, items } = get();
        if (index + 1 >= items.length) return false;
        set({ index: index + 1 });
        return true;
      },

      setPlaying: (playing) => set({ playing }),
      setSize: (size) => set({ size }),
      setAutoCamera: (autoCamera) => set({ autoCamera }),
      setPipOpen: (pipOpen) => set({ pipOpen }),
      setPipSize: (pipSize) => set({ pipSize }),
    }),
    {
      name: 'globeride.velo.show.v1',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (s) => ({ size: s.size, pipSize: s.pipSize }),
      merge: (persisted, current) => {
        const p = persisted as Partial<ShowState> | undefined;
        const size = p?.size;
        return {
          ...current,
          size: size && SHOW_SIZES.includes(size) ? size : current.size,
          pipSize: isPipSize(p?.pipSize) ? p.pipSize : current.pipSize,
        };
      },
    },
  ),
);

/** True when the rider is watching something: voice lines would talk over it. */
export function showIsPlaying(): boolean {
  const s = useShowStore.getState();
  return s.active && s.playing;
}

// ---------------------------------------------------------------------------
// Player commands from outside the panel (handlebar buttons)
// ---------------------------------------------------------------------------

/** What the handlebar buttons can ask the show player to do. */
export type ShowPlayerCommand = 'togglePlay' | 'next';

const playerListeners = new Set<(cmd: ShowPlayerCommand) => void>();

/** The player (the <video> element's owner) listens; nothing happens without one. */
export function onShowPlayerCommand(listener: (cmd: ShowPlayerCommand) => void): () => void {
  playerListeners.add(listener);
  return () => playerListeners.delete(listener);
}

/** Ask the player to play/pause or skip to the next video. False when no player listens. */
export function sendShowPlayerCommand(cmd: ShowPlayerCommand): boolean {
  if (playerListeners.size === 0) return false;
  for (const fn of [...playerListeners]) fn(cmd);
  return true;
}

// ---------------------------------------------------------------------------
// Ride view lifetime
// ---------------------------------------------------------------------------

let rideViews = 0;

/**
 * Call when the ride view mounts. Returns the matching release, which ends
 * show mode once no ride view is mounted. The end is deferred one tick so a
 * StrictMode mount → unmount → mount replay doesn't drop the videos the rider
 * picked on Home.
 */
export function retainShowForRide(): () => void {
  rideViews += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rideViews -= 1;
    setTimeout(() => {
      if (rideViews === 0) useShowStore.getState().endShow();
    }, 0);
  };
}
