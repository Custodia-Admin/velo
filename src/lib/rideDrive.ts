/**
 * What moves the rider: the trainer's live telemetry, or Demo Mode physics.
 *
 * A paired trainer always wins, even at a standstill: 0 km/h from the
 * trainer means the rider stands still. Demo power (settings.demoPowerW,
 * pushed through solveVelocity) only drives the ride when no trainer is
 * streaming, or when the rider turned Demo Mode on.
 */

import { solveVelocity, type RiderParams } from '@/lib/physics';
import { liveGearedSpeed } from '@/lib/virtualGears';
import type { ConnectionState, RideMode } from '@/types';

/** True while a paired trainer's telemetry drives the ride. */
export function trainerDrivesRide(mode: RideMode, connection: ConnectionState): boolean {
  return mode === 'trainer' && (connection === 'connected' || connection === 'reconnecting');
}

/** True when the ride runs on simulated (demo) power. Outdoor GPS rides are neither. */
export function ridesOnDemoPower(mode: RideMode, connection: ConnectionState): boolean {
  return mode !== 'outdoor' && !trainerDrivesRide(mode, connection);
}

export interface RideDriveInput {
  mode: RideMode;
  connection: ConnectionState;
  /** Ride-store speed, m/s. */
  storeSpeed: number;
  /** The trainer's own last speed, m/s. */
  trainerSpeed: number;
  /** Trainer power, W. */
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
  demo: boolean;
}

/** Speed and power for one tick of a trainer / demo ride (not outdoor). */
export function rideDrive(i: RideDriveInput): RideDrive {
  if (trainerDrivesRide(i.mode, i.connection)) {
    const live = liveGearedSpeed(i.storeSpeed, i.trainerSpeed, i.gearFactor);
    return {
      speed: Math.max(0, live.speed || 0),
      power: Math.max(0, i.power || 0),
      displaySpeed: live.display,
      demo: false,
    };
  }
  return { speed: solveVelocity(i.demoPowerW, i.gradePct, i.rider), power: i.demoPowerW, demo: true };
}
