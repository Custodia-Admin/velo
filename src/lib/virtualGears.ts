/**
 * Virtual gears on a plain FTMS trainer.
 *
 * The trainer's physical ratio is fixed, so a gear is made in software:
 * a harder gear (factor k > 1) makes the bike go k times faster at the same
 * cadence, and the trainer resists with k times the road force at that
 * faster virtual speed, so the rider's power matches the virtual world.
 *
 * We express that resistance as the grade the trainer should simulate, given
 * the trainer adds its own rolling and air resistance from the Crr / Cw we
 * already send. At the neutral gear the input grade comes back unchanged, so
 * a ride without handlebar controls sends exactly what it sent before.
 *
 * Derivation: docs/devices/zwift-ride-v2.md ("Virtual gears on plain FTMS").
 */

import { TRAINER_GRADE_MAX, TRAINER_GRADE_MIN } from '@/lib/trainerComfort';
import { ftmsCrr, ftmsCw, type RiderParams } from '@/lib/physics';

export const GEAR_COUNT = 11;
/** 1-based. Factor 1: the trainer feels exactly as without gears. */
export const NEUTRAL_GEAR = 6;
/** Each gear is this much harder than the one below. */
export const GEAR_STEP = 1.1;

const G = 9.80665;

/** Clamp to a valid 1-based gear (NaN → neutral). */
export function clampGear(gear: number): number {
  if (!Number.isFinite(gear)) return NEUTRAL_GEAR;
  return Math.min(GEAR_COUNT, Math.max(1, Math.round(gear)));
}

/** Speed / force factor of a gear. Exactly 1 at the neutral gear. */
export function gearFactor(gear: number): number {
  const g = clampGear(gear);
  if (g === NEUTRAL_GEAR) return 1;
  return Math.pow(GEAR_STEP, g - NEUTRAL_GEAR);
}

export interface GearPhysics {
  /** Speed the trainer reports, m/s. */
  trainerSpeedMs: number;
  /** Rider + bike, kg. */
  massKg: number;
  /** Rolling resistance coefficient (e.g. 0.004). */
  crr: number;
  /** Wind resistance coefficient, kg/m (FTMS Cw, e.g. 0.32). */
  cw: number;
}

/**
 * Grade to send to the trainer so it feels like `gradePct` in `gear`.
 * `gradePct` is what we would send without gears (already comfort-scaled).
 */
export function gearedTrainerGrade(gradePct: number, gear: number, p: GearPhysics): number {
  const k = gearFactor(gear);
  if (k === 1 || !Number.isFinite(gradePct)) return gradePct;
  const m = Math.max(30, p.massKg || 0);
  const vT = Math.max(0, p.trainerSpeedMs || 0);
  const vV = vT * k;
  const rolling = m * G * p.crr;
  const road = rolling + p.cw * vV * vV;
  const trainerOwn = rolling + p.cw * vT * vT;
  const eq = k * gradePct + (100 * (k * road - trainerOwn)) / (m * G);
  const clamped = Math.min(TRAINER_GRADE_MAX, Math.max(TRAINER_GRADE_MIN, eq));
  return Math.round(clamped * 100) / 100 || 0;
}

/** Virtual speed for a trainer speed in `gear`. */
export function gearedSpeed(trainerSpeedMs: number, gear: number): number {
  return trainerSpeedMs * gearFactor(gear);
}

/**
 * Gear physics from the rider settings, using the same Crr / Cw we send over
 * FTMS. Pass `cwByteSent` when the Cw actually sent differs from the rider's
 * base Cw (live wind scales it): the trainer resists with the Cw it receives,
 * so the gear compensation must use that one too.
 */
export function gearPhysicsFor(
  rider: RiderParams,
  trainerSpeedMs: number,
  cwByteSent?: number,
): GearPhysics {
  const cwByte = cwByteSent !== undefined && Number.isFinite(cwByteSent) ? cwByteSent : ftmsCw(rider);
  return {
    trainerSpeedMs,
    massKg: rider.riderMassKg + rider.bikeMassKg,
    crr: ftmsCrr(rider) / 10000,
    cw: cwByte / 100,
  };
}

/**
 * Live trainer-mode speed in a gear.
 * `storeSpeed` is what the ride store holds, `trainerSpeed` the trainer's own
 * last figure. At factor 1 with nothing scaled yet, the store speed is used
 * untouched (the pre-gears path) and no display override is returned.
 */
export function liveGearedSpeed(
  storeSpeed: number,
  trainerSpeed: number,
  factor: number,
): { speed: number; display?: number } {
  if (factor === 1 && storeSpeed === trainerSpeed) return { speed: storeSpeed };
  const base = trainerSpeed > 0 ? trainerSpeed : storeSpeed;
  const speed = base * factor;
  return { speed, display: speed };
}
