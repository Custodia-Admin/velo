import { describe, expect, it } from 'vitest';
import { DEFAULT_RIDER, solveVelocity } from '@/lib/physics';
import { rideDrive, ridesOnDemoPower, trainerDrivesRide, type RideDriveInput } from './rideDrive';

const base: RideDriveInput = {
  mode: 'trainer',
  connection: 'connected',
  storeSpeed: 0,
  trainerSpeed: 0,
  power: 0,
  gearFactor: 1,
  demoPowerW: 190,
  gradePct: 0,
  rider: DEFAULT_RIDER,
};

describe('rideDrive', () => {
  it('paired trainer at a standstill: 0 W, 0 m/s, no demo fallback', () => {
    const d = rideDrive(base);
    expect(d).toMatchObject({ speed: 0, power: 0, demo: false });
  });

  it('paired trainer, rider pedalling: its own speed and power', () => {
    const d = rideDrive({ ...base, storeSpeed: 8, trainerSpeed: 8, power: 210 });
    expect(d).toMatchObject({ speed: 8, power: 210, demo: false });
  });

  it('paired trainer in a harder gear: speed scales from the trainer figure', () => {
    const d = rideDrive({ ...base, storeSpeed: 8, trainerSpeed: 8, power: 210, gearFactor: 1.21 });
    expect(d.speed).toBeCloseTo(9.68, 6);
    expect(d.displaySpeed).toBeCloseTo(9.68, 6);
  });

  it('a short reconnect does not turn the ride into a 190 W demo', () => {
    expect(rideDrive({ ...base, connection: 'reconnecting' }).demo).toBe(false);
  });

  it('a lost link carries the rider on physics at the last trainer power', () => {
    const d = rideDrive({ ...base, connection: 'reconnecting', storeSpeed: 9, trainerSpeed: 9, power: 0 });
    expect(d).toMatchObject({ speed: 0, power: 0, demo: false, held: true }); // stopped stays stopped
    const p = rideDrive({ ...base, connection: 'reconnecting', storeSpeed: 9, trainerSpeed: 9, power: 210, gradePct: 4 });
    expect(p.speed).toBeCloseTo(solveVelocity(210, 4, DEFAULT_RIDER), 9);
  });

  it('no trainer paired: Demo Mode physics at demo power', () => {
    const d = rideDrive({ ...base, connection: 'disconnected' });
    expect(d.demo).toBe(true);
    expect(d.power).toBe(190);
    expect(d.speed).toBeCloseTo(solveVelocity(190, 0, DEFAULT_RIDER), 9);
    expect(d.speed).toBeGreaterThan(5);
  });

  it('Demo Mode switched on wins over a paired trainer', () => {
    expect(rideDrive({ ...base, mode: 'demo', power: 250, storeSpeed: 9 }).demo).toBe(true);
  });
});

describe('trainerDrivesRide / ridesOnDemoPower', () => {
  it('only a paired (or reconnecting) trainer in trainer mode drives the ride', () => {
    expect(trainerDrivesRide('trainer', 'connected')).toBe(true);
    expect(trainerDrivesRide('trainer', 'reconnecting')).toBe(true);
    for (const c of ['disconnected', 'connecting', 'error'] as const) {
      expect(trainerDrivesRide('trainer', c)).toBe(false);
      expect(ridesOnDemoPower('trainer', c)).toBe(true);
    }
    expect(ridesOnDemoPower('outdoor', 'disconnected')).toBe(false);
  });
});
