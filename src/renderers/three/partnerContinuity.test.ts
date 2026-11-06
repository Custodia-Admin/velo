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
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { baseSlotM, PARTNER_SLOT_FLOOR_M } from '@/lib/ride/partnerSlots';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { WORLD_CATALOG } from '@/lib/world/catalog';
import { loadWorld } from '@/lib/world/loadWorld';
import { createBotDriverMemo, placeBot } from './rideDriver';
import { createSceneWorld, type SceneWorld } from './worldScene';

const ROOT = fileURLToPath(new URL('../../../public/worlds/', import.meta.url));
const SPEED = 8;
const DT = 1 / 60;
const PARTNERS = [0, 1, 2];
/** Largest sideways move of a slot between two frames, metres (3 m/s at 60 fps). */
const MAX_STEP_M = 0.05;
/** Closest any partner rides to the line and to another partner, metres. */
const MIN_GAP_M = PARTNER_SLOT_FLOOR_M;

async function sceneOf(dir: string): Promise<SceneWorld> {
  const base = join(ROOT, dir.replace(/^.*worlds\//, '').replace(/\/$/, ''));
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
  const cases = WORLD_CATALOG.flatMap((world) => world.routeIds.map((routeId) => ({ world, routeId })));

  it('covers every route of every world', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const { routeId } of cases) expect(SCENIC_ROUTE_GEOMETRY[routeId], routeId).toBeDefined();
  });

  const scenes = new Map<string, Promise<SceneWorld>>();
  for (const { world, routeId } of cases) {
    it(`${routeId}: partners keep their sides, 0.9 m clear of the rider and each other, never jump`, async () => {
      if (!scenes.has(world.id)) scenes.set(world.id, sceneOf(world.dir));
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
