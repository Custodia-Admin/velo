import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useProfileStore } from '@/stores/profileStore';
import {
  INITIAL_RIDERS,
  PER_RIDER_KEYS,
  cleanName,
  comfortDefaults,
  selectActiveRider,
  useRiderRosterStore,
} from '@/stores/riderRosterStore';

beforeEach(() => {
  useSettingsStore.setState({ ...DEFAULT_SETTINGS });
  useProfileStore.setState({ profile: null });
  useProfileStore.getState().createProfile('Rider 1');
  useRiderRosterStore.setState({ riders: INITIAL_RIDERS, activeRiderId: 'rider-1' });
});

describe('riderRosterStore', () => {
  it('starts with two neutral riders, Rider 1 active', () => {
    const s = useRiderRosterStore.getState();
    expect(s.riders).toHaveLength(2);
    expect(selectActiveRider(s).name).toBe('Rider 1');
    // The public build seeds no one's name: people rename the riders on first run.
    expect(INITIAL_RIDERS.map((r) => r.name)).toEqual(['Rider 1', 'Rider 2']);
  });

  it('comfort defaults are easy, Play mode off', () => {
    const d = comfortDefaults();
    expect(d.trainerDifficulty).toBeGreaterThanOrEqual(0.3);
    expect(d.trainerDifficulty).toBeLessThanOrEqual(0.4);
    expect(d.playMode).toBe(false);
  });

  it('keeps Play mode per rider', () => {
    useSettingsStore.getState().setSettings({ playMode: true });
    useRiderRosterStore.getState().switchRider('rider-2');
    expect(useSettingsStore.getState().playMode).toBe(false);
    useRiderRosterStore.getState().switchRider('rider-1');
    expect(useSettingsStore.getState().playMode).toBe(true);
  });

  it('swaps per-rider settings and keeps household settings', () => {
    useSettingsStore.getState().setSettings({
      riderMassKg: 82,
      ftpW: 240,
      trainerDifficulty: 0.5,
      units: 'imperial',
      rideAudioVolume: 20,
    });

    useRiderRosterStore.getState().switchRider('rider-2');
    let live = useSettingsStore.getState();
    // Rider 2 starts from comfort defaults…
    expect(live.riderMassKg).toBe(DEFAULT_SETTINGS.riderMassKg);
    expect(live.ftpW).toBe(DEFAULT_SETTINGS.ftpW);
    expect(live.trainerDifficulty).toBe(DEFAULT_SETTINGS.trainerDifficulty);
    // …while household settings carry over.
    expect(live.units).toBe('imperial');
    expect(live.rideAudioVolume).toBe(20);

    live.setSettings({ riderMassKg: 58, trainerDifficulty: 0.3 });
    useRiderRosterStore.getState().switchRider('rider-1');
    live = useSettingsStore.getState();
    expect(live.riderMassKg).toBe(82);
    expect(live.ftpW).toBe(240);
    expect(live.trainerDifficulty).toBe(0.5);

    useRiderRosterStore.getState().switchRider('rider-2');
    live = useSettingsStore.getState();
    expect(live.riderMassKg).toBe(58);
    expect(live.trainerDifficulty).toBe(0.3);
  });

  it('keeps a separate profile per rider', () => {
    const first = useProfileStore.getState().profile;
    expect(first?.displayName).toBe('Rider 1');
    useRiderRosterStore.getState().switchRider('rider-2');
    const second = useProfileStore.getState().profile;
    expect(second?.displayName).toBe('Rider 2');
    expect(second?.id).not.toBe(first?.id);
    useRiderRosterStore.getState().switchRider('rider-1');
    expect(useProfileStore.getState().profile).toEqual(first);
  });

  it('ignores unknown or current rider ids', () => {
    const before = useRiderRosterStore.getState();
    before.switchRider('rider-1');
    before.switchRider('nobody');
    expect(useRiderRosterStore.getState().activeRiderId).toBe('rider-1');
    expect(useRiderRosterStore.getState().riders).toBe(before.riders);
  });

  it('renames riders and the active profile', () => {
    useRiderRosterStore.getState().renameRider('rider-1', '  Fede  ');
    expect(selectActiveRider(useRiderRosterStore.getState()).name).toBe('Fede');
    expect(useProfileStore.getState().profile?.displayName).toBe('Fede');
    useRiderRosterStore.getState().renameRider('rider-2', '   ');
    expect(useRiderRosterStore.getState().riders[1].name).toBe('Rider 2');
  });

  it('cleans names', () => {
    expect(cleanName('a   b', 'x')).toBe('a b');
    expect(cleanName('x'.repeat(40), 'y')).toHaveLength(24);
  });

  it('per-rider keys are all real settings', () => {
    for (const k of PER_RIDER_KEYS) expect(k in DEFAULT_SETTINGS).toBe(true);
  });
});

describe('riderRosterStore persistence', () => {
  /** A fresh store module over a localStorage holding `saved` under the roster key. */
  async function storeOver(saved: unknown) {
    const data = new Map<string, string>();
    if (saved !== undefined) data.set('globeride.velo.riders.v1', JSON.stringify({ state: saved, version: 1 }));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    vi.resetModules();
    const mod = await import('@/stores/riderRosterStore');
    await mod.useRiderRosterStore.persist.rehydrate();
    return mod.useRiderRosterStore.getState();
  }

  it('keeps the names a browser already saved, and seeds Rider 1/Rider 2 only when none are saved', async () => {
    try {
      const saved = await storeOver({
        riders: [
          { id: 'rider-1', name: 'Ada', settings: null, profile: null },
          { id: 'rider-2', name: 'Bea', settings: null, profile: null },
        ],
        activeRiderId: 'rider-2',
      });
      expect(saved.riders.map((r) => r.name)).toEqual(['Ada', 'Bea']);
      expect(saved.activeRiderId).toBe('rider-2');
      const fresh = await storeOver(undefined);
      expect(fresh.riders.map((r) => r.name)).toEqual(['Rider 1', 'Rider 2']);
      expect(fresh.activeRiderId).toBe('rider-1');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
