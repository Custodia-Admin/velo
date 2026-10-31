/**
 * riderRosterStore — the two Velo riders sharing one trainer.
 *
 * The live settingsStore + profileStore always hold the ACTIVE rider, so every
 * existing consumer keeps working untouched. Switching riders snapshots the
 * per-rider fields of the outgoing rider into their roster slot and loads the
 * incoming rider's snapshot back into the live stores.
 *
 * Shared across riders (not swapped): units, graphics, audio, commentary,
 * voice, gestures, low-light HUD, Strava auto-upload.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_SETTINGS, useSettingsStore, type RiderSettings } from '@/stores/settingsStore';
import { useProfileStore, type RiderProfile } from '@/stores/profileStore';

/** Settings that belong to a person rather than to the household. */
export const PER_RIDER_KEYS = [
  'riderMassKg',
  'bikeMassKg',
  'bikeType',
  'riderPosition',
  'demoPowerW',
  'ftpW',
  'avatar',
  'helmetId',
  'bikeId',
  'kitId',
  'glassesId',
  'shoesId',
  'bottleId',
  'coachGoal',
  'coachPlan',
  'cameraMode',
  'trainerDifficulty',
  'ergEnabled',
] as const satisfies readonly (keyof RiderSettings)[];

export type PerRiderKey = (typeof PER_RIDER_KEYS)[number];
export type PerRiderSettings = Pick<RiderSettings, PerRiderKey>;

export interface RosterRider {
  id: string;
  name: string;
  /** Null until this rider has been active at least once; then a snapshot. */
  settings: PerRiderSettings | null;
  /** XP / lifetime totals snapshot. Null until first switch away. */
  profile: RiderProfile | null;
}

export const MAX_NAME_LENGTH = 24;

/** Comfort-first defaults every new rider starts from. */
export function comfortDefaults(): PerRiderSettings {
  return pickPerRider(DEFAULT_SETTINGS);
}

export function pickPerRider(src: RiderSettings): PerRiderSettings {
  const out = {} as Record<PerRiderKey, unknown>;
  for (const k of PER_RIDER_KEYS) out[k] = structuredCloneSafe(src[k]);
  return out as PerRiderSettings;
}

function structuredCloneSafe<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

export function cleanName(name: string, fallback: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return trimmed || fallback;
}

export const INITIAL_RIDERS: RosterRider[] = [
  { id: 'rider-1', name: 'Federico', settings: null, profile: null },
  { id: 'rider-2', name: 'Rider 2', settings: null, profile: null },
];

interface RosterState {
  riders: RosterRider[];
  activeRiderId: string;
  /** Make `id` the active rider. No-op for the current or an unknown id. */
  switchRider: (id: string) => void;
  renameRider: (id: string, name: string) => void;
}

export const useRiderRosterStore = create<RosterState>()(
  persist(
    (set, get) => ({
      riders: INITIAL_RIDERS,
      activeRiderId: INITIAL_RIDERS[0].id,

      switchRider: (id) => {
        const { riders, activeRiderId } = get();
        if (id === activeRiderId) return;
        const incoming = riders.find((r) => r.id === id);
        if (!incoming) return;

        // Snapshot the outgoing rider from the live stores.
        const live = useSettingsStore.getState();
        const outgoingSettings = pickPerRider(live);
        const outgoingProfile = useProfileStore.getState().profile;

        const nextRiders = riders.map((r) =>
          r.id === activeRiderId
            ? { ...r, settings: outgoingSettings, profile: outgoingProfile }
            : r,
        );

        // Load the incoming rider into the live stores.
        live.setSettings(incoming.settings ?? comfortDefaults());
        useProfileStore.setState({ profile: incoming.profile });
        if (!incoming.profile) useProfileStore.getState().createProfile(incoming.name);

        set({ riders: nextRiders, activeRiderId: id });
      },

      renameRider: (id, name) => {
        const { riders, activeRiderId } = get();
        const target = riders.find((r) => r.id === id);
        if (!target) return;
        const next = cleanName(name, target.name);
        set({ riders: riders.map((r) => (r.id === id ? { ...r, name: next } : r)) });
        if (id === activeRiderId) useProfileStore.getState().renameProfile(next);
      },
    }),
    {
      // 'globeride.' prefix so local backups (lib/dataBackup) include the roster.
      name: 'globeride.velo.riders.v1',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // Keep exactly two riders even if storage is edited or truncated.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<RosterState>;
        const riders = INITIAL_RIDERS.map((base) => {
          const saved = p.riders?.find((r) => r?.id === base.id);
          return saved
            ? {
                id: base.id,
                name: cleanName(String(saved.name ?? ''), base.name),
                settings: saved.settings ? { ...comfortDefaults(), ...saved.settings } : null,
                profile: saved.profile ?? null,
              }
            : base;
        });
        const activeRiderId = riders.some((r) => r.id === p.activeRiderId)
          ? (p.activeRiderId as string)
          : riders[0].id;
        return { ...current, riders, activeRiderId };
      },
      partialize: (s) => ({ riders: s.riders, activeRiderId: s.activeRiderId }),
    },
  ),
);

/** Convenience selector: the active rider record. */
export function selectActiveRider(s: Pick<RosterState, 'riders' | 'activeRiderId'>): RosterRider {
  return s.riders.find((r) => r.id === s.activeRiderId) ?? s.riders[0];
}
