/**
 * Test fixture: record a ride the way the app does, through the real
 * rideStore.tick, with the ride loop's own sampling (useRideLoop: wall clock
 * `now`, frame step capped at 0.1 s, a sample once a second, the position
 * taken before the step) and the recorder's closing sample
 * (useRideHistoryRecorder). Returns the saved samples plus the ground truth:
 * where the rider was at every frame on their own ride clock.
 *
 * Used by the ghost replay tests (lib/play/ghostReplay.test.ts,
 * renderers/three/coupleGhost.test.ts). Not imported by the app.
 */

import { sampleRouteAtDistance } from '@/lib/gpxParser';
import { withClosingSample } from '@/lib/rideHistory';
import { useRideStore } from '@/stores/rideStore';
import type { Route, TelemetrySample } from '@/types';

export interface RecordedFrame {
  /** Ride clock at this frame (before its step), seconds. */
  rideSec: number;
  distance: number;
  lat: number;
  lon: number;
}

export interface RecordedRide {
  startedAt: number;
  samples: TelemetrySample[];
  frames: RecordedFrame[];
  /** Wall-clock length of the ride, seconds (pauses included). */
  wallSec: number;
}

export interface RecordPlan {
  /** Ride this many metres (or to the end of the route). */
  lengthM: number;
  /** Frame time in ms at a given wall second (e.g. 16.7, or 160 for a slow stretch). */
  frameMs?: (wallSec: number) => number;
  /** Pauses: [at ride distance m, for wall seconds]. */
  pauses?: [number, number][];
  /** Speed at a ride second, m/s. */
  speed?: (rideSec: number) => number;
  startWallMs?: number;
}

export function recordRide(route: Route, plan: RecordPlan): RecordedRide {
  const frameMs = plan.frameMs ?? (() => 1000 / 60);
  const speedAt = plan.speed ?? ((t: number) => 8 + 3 * Math.sin(t / 20));
  const pauses = [...(plan.pauses ?? [])];
  const store = useRideStore.getState();
  store.setRoute(route);
  store.reset();
  let wall = plan.startWallMs ?? 1_800_000_000_000;
  const nowSpy = Date.now;
  Date.now = () => wall;
  try {
    useRideStore.getState().start();
  } finally {
    Date.now = nowSpy;
  }
  const startedAt = useRideStore.getState().startedAt ?? wall;
  let lastSampleT = 0;
  const frames: RecordedFrame[] = [];
  const end = Math.min(plan.lengthM, route.totalDistance);
  for (let guard = 0; guard < 2_000_000; guard++) {
    const s = useRideStore.getState();
    if (s.rideState !== 'running' || s.distance >= end) break;
    if (pauses.length && s.distance >= pauses[0][0]) {
      const [, forSec] = pauses.shift()!;
      s.pause();
      wall += forSec * 1000;
      useRideStore.getState().resume();
      continue;
    }
    const ms = frameMs((wall - startedAt) / 1000);
    wall += ms;
    const dt = Math.min(0.1, ms / 1000);
    const distanceNow = s.distance;
    const at = sampleRouteAtDistance(route, distanceNow);
    frames.push({ rideSec: s.elapsedMs / 1000, distance: distanceNow, lat: at.lat, lon: at.lon });
    const recordSample = wall - lastSampleT >= 1000;
    if (recordSample) lastSampleT = wall;
    const speed = speedAt(s.elapsedMs / 1000);
    s.tick({
      now: wall,
      dt,
      gradeNow: 0,
      elevationNow: at.ele,
      speedNow: speed,
      positionNow: { lat: at.lat, lon: at.lon },
      recordSample,
      cadenceNow: 85,
      powerNow: 180,
      heartRateNow: null,
    });
  }
  const fin = useRideStore.getState();
  const last = sampleRouteAtDistance(route, fin.distance);
  frames.push({ rideSec: fin.elapsedMs / 1000, distance: fin.distance, lat: last.lat, lon: last.lon });
  const samples = withClosingSample(fin.samples, {
    t: wall,
    lat: last.lat,
    lon: last.lon,
    ele: last.ele,
    distance: fin.distance,
    speed: fin.speed,
    grade: fin.grade,
    rideMs: fin.elapsedMs,
  });
  return { startedAt, samples, frames, wallSec: (wall - startedAt) / 1000 };
}

/** Metres between two lat/lon points (equirectangular; fine over metres). */
export function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = 111_320;
  const dx = (b.lon - a.lon) * k * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * k;
  return Math.hypot(dx, dy);
}
