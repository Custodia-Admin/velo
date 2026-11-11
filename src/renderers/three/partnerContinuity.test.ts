/**
 * Pace partners ridden frame by frame over every route of every shipped
 * world (the same per-frame code Rider.tsx's BotRider runs: placeBot with
 * one driver memo per partner, 60 fps, 8 m/s). Review of PR #55 @c10de1a:
 * 'ready' and a 6 s ride at the start (≥ 5 m roads) looked right, while
 * mid-ride the road clamp took a neighbouring ribbon the route isn't on and
 * the slot snapped whenever the ribbon under it changed:
 *
 * | route | frames on the wrong side | partners 0+1 < 0.9 m apart | max 1-frame step |
 * |---|---|---|---|
 * | Tiber park | 30 | 13 | 3.83 m |
 * | Assisi valley | 117 | 49 | 5.08 m |
 * | Lugano–Melide | 0 | 0 | 1.48 m |
 * | Locarno–Brissago | 68 | 42 | 3.56 m |
 *
 * Card t_c4c293dc: on the 1.5 m paths most of Tiber rides, the clamp alone
 * drew a partner level with the rider under 0.9 m from them on 67–68 % of
 * Tiber's frames (15–21 % Assisi, 0.8 % Lugano, 7–11 % Locarno; closest
 * 0.13 m), and partners 0 and 2 within 0.9 m of each other on 88 % of
 * Tiber's frames.
 *
 * Every frame here: every partner on its own side and at least 0.9 m from
 * the line (the rider, when level), partners 0 and 1 and partners 0 and 2
 * at least 0.9 m apart, and no slot moving more than 0.05 m between two
 * frames (3 m/s sideways).
 *
 * Card t_ffc99d86: the rider steers up to 1.6 m off the line (steerFeel), so
 * the second half rides each route again with fuzzed lever sequences through
 * the real lane spring (driveRideFrame → stepLane, the levers held 0.05–2 s:
 * full lock either way, released, or part-way). Before the partners gave
 * way, full lock put the rider inside partner 0 or 1 on every route. Every
 * frame: no partner drawn within 0.9 m of the drawn rider, none on the wrong
 * side of the line, none moving more than 2.5 m/s sideways; level partners
 * also keep 0.9 m from each other. A second ride has the partners drifting
 * ±8 m around the rider at up to 3 m/s, so they drop back, move up and
 * overtake while the rider steers (seeds 7–179 swept before this landed;
 * the two below are the committed ones).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readableWorldBundles } from '../../../tools/worldbake/worldBundles.mjs';

import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { baseSlotM, PARTNER_SLOT_FLOOR_M } from '@/lib/ride/partnerSlots';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { WORLD_CATALOG } from '@/lib/world/catalog';
import { loadWorld } from '@/lib/world/loadWorld';
import { PARTNER_SLOT_MAX_RATE_MPS } from '@/lib/ride/partnerSlots';
import { createBotDriverMemo, createRideDriverMemo, driveRideFrame, placeBot, placeBots, riderBeside } from './rideDriver';
import { createRideFrame, createSceneWorld, type SceneWorld } from './worldScene';

/** Every bundle in public/worlds, plus each remote one whose files are on disk (worldBundles.mjs). */
const BUNDLE_DIRS = new Map<string, string>(readableWorldBundles().map((b: { id: string; dir: string }) => [b.id, b.dir]));
const SPEED = 8;
const DT = 1 / 60;
const PARTNERS = [0, 1, 2];
/** Largest sideways move of a slot between two frames, metres (3 m/s at 60 fps). */
const MAX_STEP_M = 0.05;
/** Closest any partner rides to the line and to another partner, metres. */
const MIN_GAP_M = PARTNER_SLOT_FLOOR_M;

async function sceneOf(id: string, dir: string): Promise<SceneWorld> {
  const base = BUNDLE_DIRS.get(id)!;
  const fetch = async (url: string) => {
    try {
      return new Response(readFileSync(join(base, url.replace(/^.*\//, ''))), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
  return createSceneWorld(await loadWorld(`/worlds/${dir}`, { fetch, verifyHashes: false }));
}

interface Worst {
  /** Furthest any partner is drawn across the line from its own side, metres, and where. */
  wrongM: number;
  wrongAt: string;
  /** Closest any partner is drawn to the line on its own side, metres, and where. */
  nearM: number;
  nearAt: string;
  /** Closest partners 0 and 1 come, metres, and where. */
  gapM: number;
  gapAt: string;
  /** Closest partners 0 and 2 (both right of the line) come, metres, and where. */
  gap02M: number;
  gap02At: string;
  /** Largest slot change between two frames, metres, and where. */
  stepM: number;
  stepAt: string;
  frames: number;
}

function rideAll(sw: SceneWorld, routeId: string): Worst {
  const route = routeFromGeometry(routeId, routeId, SCENIC_ROUTE_GEOMETRY[routeId]);
  const memos = PARTNERS.map(() => createBotDriverMemo());
  const prev: number[] = [];
  const w: Worst = { wrongM: -Infinity, wrongAt: '', nearM: Infinity, nearAt: '', gapM: Infinity, gapAt: '', gap02M: Infinity, gap02At: '', stepM: 0, stepAt: '', frames: 0 };
  for (let d = 0; d <= route.totalDistance; d += SPEED * DT) {
    const at = sampleRouteAtDistance(route, d);
    const bot = { distance: d, speed: SPEED, heading: headingAt(route, d), lat: at.lat, lon: at.lon };
    const placed = PARTNERS.map((i) => placeBot(sw, route, bot, i, memos[i], DT));
    placed.forEach((p, i) => {
      const wrong = -p.slotM * Math.sign(baseSlotM(i));
      if (wrong > w.wrongM) [w.wrongM, w.wrongAt] = [wrong, `partner ${i} at ${d.toFixed(1)} m`];
      if (-wrong < w.nearM) [w.nearM, w.nearAt] = [-wrong, `partner ${i} at ${d.toFixed(1)} m`];
      if (w.frames > 0) {
        const step = Math.abs(p.slotM - prev[i]);
        if (step > w.stepM) [w.stepM, w.stepAt] = [step, `partner ${i} at ${d.toFixed(1)} m`];
      }
      prev[i] = p.slotM;
    });
    const [a, b, c] = placed.map((p) => p.placement.position);
    const gap = Math.hypot(a.x - b.x, a.z - b.z);
    if (gap < w.gapM) [w.gapM, w.gapAt] = [gap, `${d.toFixed(1)} m`];
    const gap02 = Math.hypot(a.x - c.x, a.z - c.z);
    if (gap02 < w.gap02M) [w.gap02M, w.gap02At] = [gap02, `${d.toFixed(1)} m`];
    w.frames++;
  }
  return w;
}

describe('pace partner slots, frame by frame on the shipped worlds', () => {
  const cases = WORLD_CATALOG.filter((w) => BUNDLE_DIRS.has(w.id)).flatMap((world) => world.routeIds.map((routeId) => ({ world, routeId })));

  it('covers every route of every world', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const { routeId } of cases) expect(SCENIC_ROUTE_GEOMETRY[routeId], routeId).toBeDefined();
  });

  const scenes = new Map<string, Promise<SceneWorld>>();
  for (const { world, routeId } of cases) {
    it(`${routeId}: partners keep their sides, 0.9 m clear of the rider and each other, never jump`, async () => {
      if (!scenes.has(world.id)) scenes.set(world.id, sceneOf(world.id, world.dir));
      const w = rideAll(await scenes.get(world.id)!, routeId);
      expect(w.frames).toBeGreaterThan(10_000);
      expect(w.wrongM, `wrong side ${w.wrongAt}`).toBeLessThan(0);
      expect(w.nearM, `near the line ${w.nearAt}`).toBeGreaterThanOrEqual(MIN_GAP_M - 1e-9);
      // Drawn positions: the slot across the heading, through the projection (≤ 0.5 % apart).
      expect(w.gapM, `partners 0+1 at ${w.gapAt}`).toBeGreaterThanOrEqual(2 * MIN_GAP_M - 0.01);
      expect(w.gap02M, `partners 0+2 at ${w.gap02At}`).toBeGreaterThanOrEqual(MIN_GAP_M - 0.01);
      expect(w.stepM, `1-frame step ${w.stepAt}`).toBeLessThanOrEqual(MAX_STEP_M);
    }, 120_000);
  }
});

/** A seeded uniform [0, 1) generator (LCG), so a failure replays. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

interface SteerWorst {
  /** Closest any partner is drawn to the drawn rider, metres, and where. */
  clearM: number;
  clearAt: string;
  /** Closest any partner's slot comes to the line on its own side (< 0: wrong side), metres. */
  sideM: number;
  sideAt: string;
  /** Largest slot change between two frames, metres. */
  stepM: number;
  /** Closest partners 0+1 and 0+2 come, metres. */
  gapM: number;
  gap02M: number;
  /** Frames a partner was drawn ≥ 0.5 m back, and the furthest out any slot went past its home. */
  dropFrames: number;
  outM: number;
  frames: number;
}

/**
 * Ride the route at 8 m/s with fuzzed levers through the real lane spring
 * (driveRideFrame), the partners placed every frame as BotRider places them
 * (placeBots with the frame's rider). `drift`: partners wander ±8 m along
 * the road around the rider at up to 3 m/s.
 */
function rideSteering(sw: SceneWorld, routeId: string, seed: number, drift: boolean): SteerWorst {
  const route = routeFromGeometry(routeId, routeId, SCENIC_ROUTE_GEOMETRY[routeId]);
  const rand = rng(seed);
  const frame = createRideFrame();
  const rideMemo = createRideDriverMemo();
  const memos = PARTNERS.map(() => createBotDriverMemo());
  const homes = PARTNERS.map(() => 0);
  const delta = PARTNERS.map(() => 0);
  const rel = PARTNERS.map(() => 0);
  const relLeft = PARTNERS.map(() => 0);
  const prev: number[] = [];
  let steer = 0;
  let steerLeft = 0;
  let t = 0;
  const w: SteerWorst = { clearM: Infinity, clearAt: '', sideM: Infinity, sideAt: '', stepM: 0, gapM: Infinity, gap02M: Infinity, dropFrames: 0, outM: 0, frames: 0 };
  for (let d = 0; d <= route.totalDistance; d += SPEED * DT) {
    t += DT;
    if ((steerLeft -= DT) <= 0) {
      steerLeft = 0.05 + rand() * 1.95;
      const u = rand();
      steer = u < 0.35 ? (rand() < 0.5 ? -1 : 1) : u < 0.6 ? 0 : rand() * 2 - 1;
    }
    driveRideFrame(frame, rideMemo, sw, {
      route,
      distance: d,
      speed: SPEED,
      grade: 0,
      cadence: 0,
      power: 0,
      rideState: 'running',
      steer,
      override: null,
      lookAheadM: 7,
      dt: DT,
      timeS: t,
    });
    const bots = PARTNERS.map((i) => {
      if (drift) {
        if ((relLeft[i] -= DT) <= 0) {
          relLeft[i] = 0.5 + rand() * 2.5;
          rel[i] = (rand() * 2 - 1) * 3;
        }
        delta[i] += rel[i] * DT;
        if (Math.abs(delta[i]) > 8) rel[i] = -Math.sign(delta[i]) * Math.abs(rel[i]);
        delta[i] = Math.max(-8, Math.min(8, delta[i]));
      }
      const bd = Math.max(0, Math.min(route.totalDistance, d + delta[i]));
      const at = sampleRouteAtDistance(route, bd);
      return { distance: bd, speed: SPEED + rel[i], heading: headingAt(route, bd), lat: at.lat, lon: at.lon };
    });
    const placed = placeBots(sw, route, bots, memos, DT, undefined, riderBeside(frame));
    const r = frame.placement!.position;
    placed.forEach((p, i) => {
      const side = Math.sign(baseSlotM(i));
      const where = `partner ${i} at ${d.toFixed(1)} m (lane ${frame.pose!.laneOffsetM.toFixed(2)}, slot ${p.slotM.toFixed(2)}, back ${p.backM.toFixed(2)})`;
      const clear = Math.hypot(p.placement.position.x - r.x, p.placement.position.z - r.z);
      if (clear < w.clearM) [w.clearM, w.clearAt] = [clear, where];
      if (side * p.slotM < w.sideM) [w.sideM, w.sideAt] = [side * p.slotM, where];
      if (w.frames > 0) w.stepM = Math.max(w.stepM, Math.abs(p.slotM - prev[i]));
      prev[i] = p.slotM;
      if (p.backM >= 0.5) w.dropFrames++;
      homes[i] = Math.max(homes[i], side * p.slotM);
    });
    const [a, b, c] = placed.map((p) => p.placement.position);
    w.gapM = Math.min(w.gapM, Math.hypot(a.x - b.x, a.z - b.z));
    w.gap02M = Math.min(w.gap02M, Math.hypot(a.x - c.x, a.z - c.z));
    w.frames++;
  }
  w.outM = Math.max(...homes.map((m, i) => m - Math.abs(baseSlotM(i))));
  return w;
}

describe('pace partners giving way to a steering rider, frame by frame on the shipped worlds', () => {
  const cases = WORLD_CATALOG.filter((w) => BUNDLE_DIRS.has(w.id)).flatMap((world) => world.routeIds.map((routeId) => ({ world, routeId })));
  const scenes = new Map<string, Promise<SceneWorld>>();
  /** Drawn positions, through the projection (≤ 0.5 % apart), as above. */
  const DRAWN_TOL_M = 0.01;

  for (const { world, routeId } of cases) {
    for (const drift of [false, true]) {
      const title = drift ? 'partners riding past' : 'level partners';
      it(`${routeId}, ${title}: never within 0.9 m of the steering rider, never swap sides, ≤ 2.5 m/s sideways`, async () => {
        if (!scenes.has(world.id)) scenes.set(world.id, sceneOf(world.id, world.dir));
        const w = rideSteering(await scenes.get(world.id)!, routeId, drift ? 11 : 7, drift);
        expect(w.frames).toBeGreaterThan(10_000);
        expect(w.clearM, `closest to the rider: ${w.clearAt}`).toBeGreaterThanOrEqual(MIN_GAP_M - DRAWN_TOL_M);
        expect(w.sideM, `closest to the line: ${w.sideAt}`).toBeGreaterThanOrEqual(MIN_GAP_M - 1e-9);
        expect(w.stepM).toBeLessThanOrEqual(PARTNER_SLOT_MAX_RATE_MPS * DT + 1e-9);
        // The rider really did steer into them: they moved out past their slots.
        expect(w.outM).toBeGreaterThan(0.5);
        // Level partners keep 0.9 m from each other too. Partners at different
        // distances meet at bends and hairpins whatever the rider does (the route
        // folds back under them): there it is best effort, not asserted.
        if (!drift) {
          expect(w.gapM, 'partners 0+1').toBeGreaterThanOrEqual(2 * MIN_GAP_M - DRAWN_TOL_M);
          expect(w.gap02M, 'partners 0+2').toBeGreaterThanOrEqual(MIN_GAP_M - DRAWN_TOL_M);
        }
        // Tiber rides 1.5 m paths: there the road leaves no room and partners drop back.
        if (routeId === 'scenic-perugia-tiber-park') expect(w.dropFrames).toBeGreaterThan(1000);
      }, 180_000);
    }
  }
});
