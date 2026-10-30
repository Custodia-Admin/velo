import { describe, it, expect } from 'vitest';
import {
  GEAR_COUNT,
  NEUTRAL_GEAR,
  clampGear,
  gearFactor,
  gearedSpeed,
  gearedTrainerGrade,
  liveGearedSpeed,
  type GearPhysics,
} from './virtualGears';
import { TRAINER_GRADE_MAX, TRAINER_GRADE_MIN } from './trainerComfort';

const flat: GearPhysics = { trainerSpeedMs: 6, massKg: 83, crr: 0.004, cw: 0.32 };

describe('gears', () => {
  it('neutral gear is an exact identity (trainer-only rides unchanged)', () => {
    for (const g of [-10, -3.2, 0, 2.1, 7.77, 20]) {
      expect(gearedTrainerGrade(g, NEUTRAL_GEAR, flat)).toBe(g);
    }
    expect(gearFactor(NEUTRAL_GEAR)).toBe(1);
    expect(gearedSpeed(6.3, NEUTRAL_GEAR)).toBe(6.3);
  });

  it('clamps gear numbers', () => {
    expect(clampGear(0)).toBe(1);
    expect(clampGear(99)).toBe(GEAR_COUNT);
    expect(clampGear(Number.NaN)).toBe(NEUTRAL_GEAR);
    expect(clampGear(3.4)).toBe(3);
  });

  it('factors rise monotonically from easiest to hardest', () => {
    for (let g = 2; g <= GEAR_COUNT; g++) expect(gearFactor(g)).toBeGreaterThan(gearFactor(g - 1));
    expect(gearFactor(1)).toBeCloseTo(0.62, 2);
    expect(gearFactor(GEAR_COUNT)).toBeCloseTo(1.61, 2);
  });

  it('harder gear feels harder, easier gear easier', () => {
    const base = gearedTrainerGrade(2, NEUTRAL_GEAR, flat);
    expect(gearedTrainerGrade(2, NEUTRAL_GEAR + 2, flat)).toBeGreaterThan(base);
    expect(gearedTrainerGrade(2, NEUTRAL_GEAR - 2, flat)).toBeLessThan(base);
  });

  it('gives a sensible flat-road figure (two gears up at 21.6 km/h ≈ +1.2 %)', () => {
    expect(gearedTrainerGrade(0, NEUTRAL_GEAR + 2, flat)).toBeCloseTo(1.18, 1);
  });

  it('power balance: trainer force × trainer speed = road force × virtual speed', () => {
    const p = flat;
    const gear = NEUTRAL_GEAR + 3;
    const grade = 3;
    const sent = gearedTrainerGrade(grade, gear, p);
    const k = gearFactor(gear);
    const m = p.massKg;
    const G = 9.80665;
    const vT = p.trainerSpeedMs;
    const vV = vT * k;
    const trainerForce = m * G * (sent / 100) + m * G * p.crr + p.cw * vT * vT;
    const roadForce = m * G * (grade / 100) + m * G * p.crr + p.cw * vV * vV;
    expect(trainerForce * vT).toBeCloseTo(roadForce * vV, 0);
  });

  it('stays inside the trainer limits', () => {
    expect(gearedTrainerGrade(19, GEAR_COUNT, { ...flat, trainerSpeedMs: 12 })).toBe(TRAINER_GRADE_MAX);
    expect(gearedTrainerGrade(-9, 1, { ...flat, trainerSpeedMs: 15 })).toBe(TRAINER_GRADE_MIN);
  });

  it('is safe with a stopped trainer and odd input', () => {
    expect(Number.isFinite(gearedTrainerGrade(2, 9, { ...flat, trainerSpeedMs: 0 }))).toBe(true);
    expect(Number.isFinite(gearedTrainerGrade(2, 9, { ...flat, massKg: 0 }))).toBe(true);
    expect(Number.isNaN(gearedTrainerGrade(Number.NaN, 9, flat))).toBe(true);
  });

  it('virtual speed scales with the gear', () => {
    expect(gearedSpeed(5, NEUTRAL_GEAR + 1)).toBeCloseTo(5.5, 6);
  });
});

describe('liveGearedSpeed', () => {
  it('neutral gear, nothing scaled: the old path, no override', () => {
    expect(liveGearedSpeed(6.2, 6.2, 1)).toEqual({ speed: 6.2 });
  });
  it('scales from the trainer figure, never from an already scaled one', () => {
    expect(liveGearedSpeed(7.26, 6, 1.21)).toEqual({ speed: 6 * 1.21, display: 6 * 1.21 });
  });
  it('back to neutral restores the trainer figure at once', () => {
    expect(liveGearedSpeed(7.26, 6, 1)).toEqual({ speed: 6, display: 6 });
  });
});
