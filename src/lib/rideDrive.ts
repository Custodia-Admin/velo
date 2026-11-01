/**
 * What moves the rider: the trainer's live telemetry, or Demo Mode physics.
 *
 * A paired trainer always wins, even at a standstill: 0 km/h from the
 * trainer means the rider stands still. Demo power (settings.demoPowerW,
 * pushed through solveVelocity) only drives the ride when no trainer is
 * streaming, or when the rider turned Demo Mode on. The decision itself is
 * the ride FSM's (`driveOf` in lib/ride/rideFsm).
 */

import { solveVelocity, type RiderParams } from '@/lib/physics';
import { liveGearedSpeed } from '@/lib/virtualGears';
import { STANDSTILL_POWER_W, driveOf, trainerLinkOf, type RideDriveKind } from '@/lib/ride/rideFsm';
import type { ConnectionState, RideMode } from '@/types';

/** True while a paired trainer's telemetry drives the ride. */
export function trainerDrivesRide(mode: RideMode, connection: ConnectionState): boolean {
  return mode === 'trainer' && (connection === 'connected' || connection === 'reconnecting');
}

/** True when the ride runs on simulated (demo) power. Outdoor GPS rides are neither. */
export function ridesOnDemoPower(mode: RideMode, connection: ConnectionState): boolean {
  return mode !== 'outdoor' && !trainerDrivesRide(mode, connection);
}

/** The FSM drive for a trainer/demo ride (not outdoor, replay or workout). */
export function indoorDriveKind(mode: RideMode, connection: ConnectionState): RideDriveKind {
  return driveOf({ source: mode === 'trainer' ? 'trainer' : 'demo', trainer: trainerLinkOf(connection) });
}

export interface RideDriveInput {
  mode: RideMode;
  connection: ConnectionState;
  /** Ride-store speed, m/s. */
  storeSpeed: number;
  /** The trainer's own last speed, m/s. */
  trainerSpeed: number;
  /** Trainer power, W (its last reading while the link is lost). */
  power: number;
  /** Virtual gear factor (1 = neutral / ERG). */
  gearFactor: number;
  demoPowerW: number;
  gradePct: number;
  rider: RiderParams;
}

export interface RideDrive {
  speed: number;
  power: number;
  /** Speed to show when it differs from `speed` (virtual gears). */
  displaySpeed?: number;
  /** True when Demo Mode power (settings.demoPowerW) moves the rider. */
  demo: boolean;
  /**
   * True while the trainer link is lost mid-ride: physics carries the rider
   * on the trainer's last power until it reconnects (HUD: "reconnecting").
   */
  held?: boolean;
}

/** Speed and power for one tick of a trainer / demo ride (not outdoor). */
export function rideDrive(i: RideDriveInput): RideDrive {
  const kind = indoorDriveKind(i.mode, i.connection);
  if (kind === 'trainer') {
    const live = liveGearedSpeed(i.storeSpeed, i.trainerSpeed, i.gearFactor);
    return {
      speed: Math.max(0, live.speed || 0),
      power: Math.max(0, i.power || 0),
      displaySpeed: live.display,
      demo: false,
    };
  }
  if (kind === 'held') {
    // No telemetry arrives, so the trainer's last speed would freeze the
    // rider at it. Physics on the last power instead: a rider who had
    // stopped stays stopped (solveVelocity floors at a crawl, so a stopped
    // rider off a descent is pinned to 0), one who was pedalling keeps a
    // road-true speed.
    const power = Math.max(0, i.power || 0);
    const stopped = power < STANDSTILL_POWER_W && i.gradePct >= 0;
    const speed = stopped ? 0 : solveVelocity(power, i.gradePct, i.rider);
    return { speed, power, demo: false, held: true };
  }
  return { speed: solveVelocity(i.demoPowerW, i.gradePct, i.rider), power: i.demoPowerW, demo: true };
}
