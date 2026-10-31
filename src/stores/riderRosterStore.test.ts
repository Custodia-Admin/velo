import { describe, it, expect, beforeEach } from 'vitest';
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
  useProfileStore.getState().createProfile('Federico');
  useRiderRosterStore.setState({ riders: INITIAL_RIDERS, activeRiderId: 'rider-1' });
});

describe('riderRosterStore', () => {
  it('starts with two riders, Federico active', () => {
    const s = useRiderRosterStore.getState();
    expect(s.riders).toHaveLength(2);
    expect(selectActiveRider(s).name).toBe('Federico');
  });

  it('comfort defaults are easy with ERG off', () => {
    const d = comfortDefaults();
    expect(d.trainerDifficulty).toBeGreaterThanOrEqual(0.3);
    expect(d.trainerDifficulty).toBeLessThanOrEqual(0.4);
    expect(d.ergEnabled).toBe(false);
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

  it('keeps a separate XP profile per rider', () => {
    useProfileStore.setState((s) => ({ profile: s.profile && { ...s.profile, xp: 500 } }));
    useRiderRosterStore.getState().switchRider('rider-2');
    expect(useProfileStore.getState().profile?.displayName).toBe('Rider 2');
    expect(useProfileStore.getState().profile?.xp).toBe(0);
    useRiderRosterStore.getState().switchRider('rider-1');
    expect(useProfileStore.getState().profile?.xp).toBe(500);
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
