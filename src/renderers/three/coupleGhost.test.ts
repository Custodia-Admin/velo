/**
 * The couple ghost as the world renderer draws it (coupleGhostDriver), on the
 * real Perugia bundle: recorded through the real ride store, loaded from
 * "history" as the other rider's last ride, then placed frame by frame.
 * Blueprint §P3.2: the ghost replays within 1 m of the recorded positions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { AVATAR_PRESETS } from '@/lib/avatarConfig';
import { loadCoupleGhost, type CoupleGhost } from '@/lib/play/coupleGhost';
import { recordRide, type RecordedRide } from '@/lib/play/recordedRideFixture';
import type { RideRecord } from '@/lib/rideHistory';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { loadWorld } from '@/lib/world/loadWorld';
import {
  GHOST_FADE_S,
  GHOST_NEAR_OPACITY,
  GHOST_OPACITY,
  createCoupleGhostMemo,
  driveCoupleGhost,
  ghostOpacity,
} from './coupleGhostDriver';
import { createSceneWorld, type SceneWorld } from './worldScene';

const DIR = fileURLToPath(new URL('../../../public/worlds/perugia', import.meta.url));
const diskFetch = async (url: string) => {
  try {
    return new Response(readFileSync(join(DIR, url.replace(/^.*\//, ''))), { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
};

const ID = 'scenic-perugia-tiber-park';
const route = routeFromGeometry(ID, 'Tiber park', SCENIC_ROUTE_GEOMETRY[ID]);

describe('couple ghost on the Perugia world', () => {
  let sw: SceneWorld;
  let ride: RecordedRide;
  let ghost: CoupleGhost;
  beforeAll(async () => {
    sw = createSceneWorld(await loadWorld('/worlds/perugia/', { fetch: diskFetch, verifyHashes: false }));
    // 3 km with a stop and a slow-frame stretch, as the app records it.
    ride = recordRide(route, {
      lengthM: 3000,
      pauses: [[900, 45]],
      frameMs: (wall) => (wall > 200 && wall < 240 ? 150 : 1000 / 60),
    });
    const record: RideRecord = {
      id: 'anna-1',
      name: 'Tiber park',
      startedAt: ride.startedAt,
      durationSec: Math.round((ride.samples[ride.samples.length - 1].rideMs as number) / 1000),
      distanceM: ride.samples[ride.samples.length - 1].distance,
      ascentM: 0,
      avgPower: 180,
      avgSpeed: 8,
      sampleCount: ride.samples.length,
      samples: ride.samples,
      source: 'route',
      riderId: 'rider-2',
      routeRef: { id: ID, name: 'Tiber park' },
    };
    ghost = (await loadCoupleGhost(route, 'last', { id: 'rider-2', name: 'Anna', colors: AVATAR_PRESETS[1].colors }, [record]))!;
  }, 60_000);

  it('is drawn within 1 m of every recorded position, at its ride time', () => {
    const memo = createCoupleGhostMemo();
    let worst = 0;
    for (const s of ride.samples) {
      const d = driveCoupleGhost(sw, route, ghost.replay, (s.rideMs as number) / 1000, null, memo, 1 / 60)!;
      const [x, y] = sw.projection.forward(s.lat, s.lon);
      worst = Math.max(worst, Math.hypot(d.placement.worldX - x, d.placement.worldY - y));
    }
    expect(ride.samples.length).toBeGreaterThan(250);
    expect(worst).toBeLessThan(1);
  });

  it('is drawn within 1 m of where the rider was at every frame of the recorded ride', () => {
    const memo = createCoupleGhostMemo();
    let worst = 0;
    for (const f of ride.frames) {
      const d = driveCoupleGhost(sw, route, ghost.replay, f.rideSec, null, memo, 1 / 60)!;
      const [x, y] = sw.projection.forward(f.lat, f.lon);
      worst = Math.max(worst, Math.hypot(d.placement.worldX - x, d.placement.worldY - y));
    }
    expect(worst).toBeLessThan(1);
  });

  it('stands on the drawn ground and faces along the road', () => {
    const memo = createCoupleGhostMemo();
    const ground = (x: number, y: number) => sw.heightfield.sampleHeight(x, y) + 0.5;
    let t = 0;
    let d = driveCoupleGhost(sw, route, ghost.replay, t, null, memo, 1 / 60, ground)!;
    for (; t < 120; t += 1 / 60) d = driveCoupleGhost(sw, route, ghost.replay, t, null, memo, 1 / 60, ground)!;
    expect(d.placement.position.y).toBeCloseTo(ground(d.placement.worldX, d.placement.worldY), 6);
    expect(d.speed).toBeGreaterThan(4);
    expect(d.cadence).toBeGreaterThan(0);
  });

  it('stands still while the ride clock does (paused, or not started)', () => {
    const memo = createCoupleGhostMemo();
    driveCoupleGhost(sw, route, ghost.replay, 60, null, memo, 1 / 60);
    const a = driveCoupleGhost(sw, route, ghost.replay, 60, null, memo, 1 / 60)!;
    expect(a.speed).toBe(0);
    expect(a.cadence).toBe(0);
  });

  it('fades as it comes level with the live rider, so the rider reads through it', () => {
    expect(ghostOpacity(null)).toBe(GHOST_OPACITY);
    expect(ghostOpacity(0)).toBe(GHOST_NEAR_OPACITY);
    expect(ghostOpacity(-1.5)).toBe(GHOST_NEAR_OPACITY);
    expect(ghostOpacity(5)).toBeGreaterThan(GHOST_NEAR_OPACITY);
    expect(ghostOpacity(5)).toBeLessThan(GHOST_OPACITY);
    expect(ghostOpacity(-30)).toBe(GHOST_OPACITY);
    const memo = createCoupleGhostMemo();
    const t = 90;
    const level = driveCoupleGhost(sw, route, ghost.replay, t, ghost.replay.distanceAt(t), memo, 1 / 60)!;
    expect(level.opacity).toBe(GHOST_NEAR_OPACITY);
  });

  it('fades out after its ride ends', () => {
    const end = ghost.replay.durationSec;
    const memo = createCoupleGhostMemo();
    expect(driveCoupleGhost(sw, route, ghost.replay, end + GHOST_FADE_S / 2, null, memo, 1 / 60)!.opacity).toBeCloseTo(GHOST_OPACITY / 2, 6);
    expect(driveCoupleGhost(sw, route, ghost.replay, end + GHOST_FADE_S + 0.1, null, memo, 1 / 60)).toBeNull();
  });
});
