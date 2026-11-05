/**
 * The drawn road under a pace partner (roadSpan.ts) and where the world
 * renderer draws each partner (rideDriver.placeBot): in its lateral slot
 * (lib/ride/partnerSlots) across the filtered heading, clamped to the
 * ribbon Roads.tsx draws there and eased toward that clamp.
 *
 * - Review of PR #45 @4ea2ff0: seated partners stood 0.0–0.1 m from the
 *   rider and covered the rider's own model.
 * - Review of PR #55 @c10de1a: mid-ride the clamp took a neighbouring
 *   ribbon the route isn't on (the route's own ribbon dropped out at bends,
 *   judged against the lagging filtered heading), so partners swapped
 *   sides, merged and jumped up to 3.8 m in one frame; and nothing pinned
 *   that the slot is drawn across the FILTERED heading.
 * - Card t_c4c293dc: on 1.5 m paths (most of the Tiber route) the clamp
 *   alone drew a partner level with the rider 0.13–0.65 m from them, and
 *   partners 0 and 2 inside each other. Past the clamp a partner now rides
 *   the verge, 0.9 m from the line and from the partner inside it.
 */
import { describe, expect, it } from 'vitest';

import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { BOT_PRESETS, createPaceBot } from '@/lib/paceBots';
import { PARTNER_EDGE_MARGIN_M, PARTNER_SLOT_FLOOR_M, PARTNER_SLOT_MAX_RATE_MPS } from '@/lib/ride/partnerSlots';
import { YAW_SNAP_M } from '@/lib/ride/rideHeading';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import type { LoadedWorld, RoadsLayer } from '@/lib/world/loadWorld';
import type { Route } from '@/types';
import { createBotDriverMemo, createRideDriverMemo, driveRideFrame, placeBot, type BotDriverMemo } from './rideDriver';
import { ROAD_GATHER_M, roadSegmentAt, roadSpanAt, spanAcross, type RoadSpanMemo } from './roadSpan';
import { syntheticSceneWorld } from './syntheticWorld';
import { createRideFrame, createSceneWorld, type SceneWorld } from './worldScene';

const DT = 1 / 60;
const DEG = Math.PI / 180;
const EAST = Math.PI / 2;
const sw = syntheticSceneWorld();

/** The synthetic world with its roads swapped (same terrain and projection). */
function withRoads(roads: RoadsLayer['roads']): SceneWorld {
  return createSceneWorld({ ...sw.world, roads: { ...sw.world.roads, roads } } as LoadedWorld);
}

/** A 1.5 m path (the bake's path/footway default) through world points [x, y, …]. */
const path = (...xy: number[]) => ({ cls: 2, width: 1.5, flags: 0, points: Float32Array.from(xy) });

/** A route through world points (x, y), sampled every ~10 m along each leg. */
function routeVia(world: SceneWorld, ...via: [number, number][]): Route {
  const pts: [number, number, number][] = [];
  let total = 0;
  for (let k = 0; k + 1 < via.length; k++) {
    const [from, to] = [via[k], via[k + 1]];
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const n = Math.max(1, Math.round(len / 10));
    for (let i = k === 0 ? 0 : 1; i <= n; i++) {
      const [lat, lon] = world.projection.inverse(from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n);
      pts.push([lat, lon, 0]);
    }
    total += len;
  }
  return routeFromGeometry('t', 't', { distanceM: Math.round(total), ascentM: 0, maxGradePct: 0, points: pts });
}

/** A straight route through world points (x, y), sampled every 10 m. */
const routeThrough = (world: SceneWorld, from: [number, number], to: [number, number]) => routeVia(world, from, to);

/** The partners seated on the start line (rideStore.reseatPaceBots does this on a route load). */
const seat = (r: Route, n: number) => BOT_PRESETS.slice(0, n).map((p, i) => createPaceBot(`b${i}`, p, r));

interface Frame {
  d: number;
  slotM: number;
  /** Where the partner is drawn, world metres, and its drawn heading. */
  x: number;
  y: number;
  heading: number;
  /** The bot's own point on the route line, world metres. */
  lineX: number;
  lineY: number;
}

/**
 * Partner `index` ridden along `route` from `from` to `to` metres at
 * `speed` m/s, 60 fps, with one driver memo for the whole ride (as
 * Rider.tsx keeps one per partner). The bot's state is what tickPaceBot
 * leaves: its point on the line and the raw ±4 m route bearing.
 */
function ride(world: SceneWorld, route: Route, index: number, from: number, to: number, speed = 8, memo: BotDriverMemo = createBotDriverMemo()): Frame[] {
  const out: Frame[] = [];
  for (let d = from; d <= to; d += speed * DT) {
    const at = sampleRouteAtDistance(route, d);
    const p = placeBot(world, route, { distance: d, speed, heading: headingAt(route, d), lat: at.lat, lon: at.lon }, index, memo, DT);
    const [lineX, lineY] = world.projection.forward(at.lat, at.lon);
    out.push({ d, slotM: p.slotM, x: p.placement.worldX, y: p.placement.worldY, heading: p.placement.heading, lineX, lineY });
  }
  return out;
}

/** Largest change of the drawn slot between two frames, metres. */
const maxStep = (frames: Frame[]) => frames.reduce((m, f, i) => (i ? Math.max(m, Math.abs(f.slotM - frames[i - 1].slotM)) : 0), 0);

describe('roadSpan', () => {
  it('finds the ribbon under a point and measures it across the travel heading', () => {
    // The synthetic E–W road: 7 m wide along y = 0.
    const seg = roadSegmentAt(sw, 10, 1, EAST)!;
    expect(seg.halfWidth).toBe(3.5);
    // Eastbound, 1 m north of the centre = 1 m left of it: 4.5 m of road to the right.
    const east = spanAcross(seg, 10, 1, EAST);
    expect(east.leftM).toBeCloseTo(-2.5, 6);
    expect(east.rightM).toBeCloseTo(4.5, 6);
    // Westbound, the same point is right of the centre.
    const west = spanAcross(seg, 10, 1, -EAST);
    expect(west.leftM).toBeCloseTo(-4.5, 6);
    expect(west.rightM).toBeCloseTo(2.5, 6);
    expect(roadSpanAt(sw, 10, 1, -EAST, -EAST)).toEqual(west);
  });

  it('counts only a ribbon whose paved width reaches the point: none off every ribbon, in a tunnel or on steps', () => {
    expect(roadSpanAt(sw, 0, 60, EAST, EAST)).toBeNull();
    // On the 7 m road 3.4 m off its centre; 3.6 m off it is beside the road.
    expect(roadSpanAt(sw, 10, 3.4, EAST, EAST)).not.toBeNull();
    expect(roadSpanAt(sw, 10, 3.6, EAST, EAST)).toBeNull();
    expect(roadSpanAt(sw, 10, 3.6, EAST, EAST, {})).toBeNull();
    // The synthetic tunnel (y = 150, x −300…−200) and steps (0,100)–(10,110) aren't drawn.
    expect(roadSegmentAt(sw, -250, 150, EAST)).toBeNull();
    expect(roadSegmentAt(sw, 5, 105, Math.PI / 4)).toBeNull();
  });

  it('never takes a neighbouring path for the road under the route', () => {
    // The route runs east along y = 0 where nothing is drawn; a 1.5 m path
    // runs beside it, its centre 2 m north (its edge 1.25 m from the line).
    // The old rule took any ribbon centre within 4 m: a span wholly left of
    // the line ([-2.75, -1.25]) that clamped every partner onto that side.
    const beside = withRoads([path(-390, 2, 390, 2)]);
    expect(roadSpanAt(beside, 0, 0, EAST, EAST)).toBeNull();
    expect(roadSpanAt(beside, 0, 0, EAST, EAST, {})).toBeNull();
    const r = routeThrough(beside, [-300, 0], [300, 0]);
    for (const i of [0, 1, 2]) {
      for (const f of ride(beside, r, i, 0, 100)) expect(f.slotM).toBeCloseTo([1.2, -1.2, 2.4][i], 9);
    }
  });

  it('of two ribbons under the point, takes the one the route follows (the nearest centreline)', () => {
    // A 1.5 m cycle path mapped along y = 0 over the edge of a 7 m road
    // centred 3 m south (y −6.5…0.5); the route rides the path.
    const lane = withRoads([{ cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, -3, 390, -3]) }, path(-390, 0, 390, 0)]);
    expect(roadSegmentAt(lane, 0, 0, EAST)!.halfWidth).toBe(0.75);
    expect(roadSpanAt(lane, 0, 0, EAST, EAST)).toEqual({ leftM: expect.closeTo(-0.75, 6), rightM: expect.closeTo(0.75, 6) });
  });

  it('finds a wide road from a point far off its centreline', () => {
    // An 18 m road (the widest the bundles draw): 8 m north of its centre is still on it.
    const wide = withRoads([{ cls: 0, width: 18, flags: 0, points: Float32Array.from([-390, 0, 390, 0]) }]);
    const span = { leftM: expect.closeTo(-1, 6), rightM: expect.closeTo(17, 6) };
    expect(roadSpanAt(wide, 10, 8, EAST, EAST)).toEqual(span);
    expect(roadSpanAt(wide, 10, 8, EAST, EAST, {})).toEqual(span);
  });

  it("takes the road running along the route's bearing, never a side road crossing it", () => {
    // A 7 m road along y = 0 and a 3 m side road along x = 0. Eastbound at
    // (0.2, 1) both cover the point, and the side road's centreline is nearer.
    const cross = withRoads([
      { cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, 0, 390, 0]) },
      { cls: 1, width: 3, flags: 0, points: Float32Array.from([0, -190, 0, 190]) },
    ]);
    expect(roadSegmentAt(cross, 0.2, 1, EAST)!.halfWidth).toBe(3.5);
    expect(roadSpanAt(cross, 0.2, 1, EAST, EAST)).toEqual({ leftM: expect.closeTo(-2.5, 6), rightM: expect.closeTo(4.5, 6) });
    // Northbound on the side road, the main road is the crossing.
    expect(roadSegmentAt(cross, 0.2, 1, 0)!.halfWidth).toBe(1.5);
    // Up to 45° off the bearing still counts as along it; past that it is a crossing.
    expect(roadSegmentAt(cross, 0.2, 1, EAST - 40 * DEG)!.halfWidth).toBe(3.5);
    expect(roadSegmentAt(cross, 0.2, 1, EAST - 50 * DEG)!.halfWidth).toBe(1.5);
  });

  it("picks the ribbon by the route's bearing, and measures it across the drawn heading", () => {
    // A 1.5 m path running 40° (NE). Through a bend the drawn heading lags:
    // here it still reads east, 50° off the path. Judged against it, the path
    // the route is on would be a crossing (PR #55 @c10de1a, Tiber 9,995.6 m).
    const ne = withRoads([path(-100 * Math.sin(40 * DEG), -100 * Math.cos(40 * DEG), 100 * Math.sin(40 * DEG), 100 * Math.cos(40 * DEG))]);
    expect(roadSpanAt(ne, 0, 0, EAST, 40 * DEG)).toEqual({ leftM: expect.closeTo(-0.75, 6), rightM: expect.closeTo(0.75, 6) });
    expect(roadSpanAt(ne, 0, 0, EAST, EAST)).toBeNull();
    // Out-and-back on an E–W path, 0.5 m north of its centre: on the way back
    // the bearing reads west while the drawn heading is still turning (100°).
    // The span is the side of the line the partner is drawn on: across the
    // drawn heading, 1.25 m of path to its right; across the bearing, 0.25 m.
    const ew = withRoads([path(-390, 0, 390, 0)]);
    expect(roadSpanAt(ew, 0, 0.5, 100 * DEG, -EAST)).toEqual({ leftM: expect.closeTo(-0.25, 6), rightM: expect.closeTo(1.25, 6) });
  });

  it('with a memo, gathers the segments around a partner once and again only when it leaves that circle', () => {
    const memo: { road?: RoadSpanMemo } = {};
    const at = (x: number, y: number) => roadSpanAt(sw, x, y, EAST, EAST, memo);
    expect(at(-300, 1)).toEqual(roadSpanAt(sw, -300, 1, EAST, EAST));
    const first = memo.road!;
    expect(first.segs.length).toBeGreaterThan(0);
    // Riding east along the road: the same gather serves the next 30 m.
    for (let x = -300; x <= -300 + ROAD_GATHER_M; x += 0.5) {
      expect(at(x, 1)).toEqual(roadSpanAt(sw, x, 1, EAST, EAST));
    }
    expect(memo.road).toBe(first);
    at(-300 + ROAD_GATHER_M + 0.5, 1);
    expect(memo.road).not.toBe(first);
    // 60 m north of the road: nothing there.
    expect(at(-270, 60)).toBeNull();
  });

  it('with a memo, finds a ribbon that was out of reach at the gather once the point leaves the circle', () => {
    // A path starting 31 m east of the gather point: its end is 30.25 m away.
    const later = withRoads([path(-269, 60, 100, 60)]);
    const memo: { road?: RoadSpanMemo } = {};
    expect(roadSpanAt(later, -300, 60, EAST, EAST, memo)).toBeNull();
    expect(roadSpanAt(later, -270, 60, EAST, EAST, memo)).toBeNull();
    expect(roadSpanAt(later, -268.5, 60, EAST, EAST, memo)).toEqual({ leftM: expect.closeTo(-0.75, 6), rightM: expect.closeTo(0.75, 6) });
  });
});

describe('placeBot', () => {
  const east = routeThrough(sw, [-300, 0], [300, 0]);

  it('stands seated partners in their slots across an east-facing start: 1.2 m right, 1.2 m left, 2.4 m right', () => {
    const at = seat(east, 3).map((b, i) => placeBot(sw, east, b.state, i, createBotDriverMemo(), DT));
    expect(at.map((p) => p.slotM)).toEqual([1.2, -1.2, 2.4]);
    // Right of an eastbound rider is south (world −y; three z = −y).
    expect(at[0].placement.worldY).toBeCloseTo(-1.2, 2);
    expect(at[1].placement.worldY).toBeCloseTo(1.2, 2);
    expect(at[2].placement.worldY).toBeCloseTo(-2.4, 2);
    for (const p of at) expect(p.placement.worldX).toBeCloseTo(-300, 1);
  });

  it('turns the slot with the heading: a north-facing partner sits east (right) or west (left)', () => {
    const north = routeThrough(sw, [0, -150], [0, 150]);
    // No road along x = 0 there: the slots are unclamped.
    const [b0, b1] = seat(north, 2);
    const r = placeBot(sw, north, b0.state, 0, createBotDriverMemo(), DT).placement;
    const l = placeBot(sw, north, b1.state, 1, createBotDriverMemo(), DT).placement;
    expect(r.worldX).toBeCloseTo(1.2, 2);
    expect(r.worldY).toBeCloseTo(-150, 1);
    expect(l.worldX).toBeCloseTo(-1.2, 2);
    expect(l.worldY).toBeCloseTo(-150, 1);
  });

  it('keeps every seated partner at least 0.9 m from the rider and from each other', () => {
    const frame = createRideFrame();
    driveRideFrame(frame, createRideDriverMemo(), sw, {
      route: east, distance: 0, speed: 0, grade: 0, cadence: 0, power: 0, rideState: 'ready',
      steer: 0, override: null, lookAheadM: 12, dt: DT, timeS: 0,
    });
    const rider = frame.placement!.position;
    const bots = seat(east, 3).map((b, i) => placeBot(sw, east, b.state, i, createBotDriverMemo(), DT).placement.position);
    for (const p of bots) expect(Math.hypot(p.x - rider.x, p.z - rider.z)).toBeGreaterThanOrEqual(0.9);
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        expect(Math.hypot(bots[i].x - bots[j].x, bots[i].z - bots[j].z)).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it('clamps a slot to the drawn ribbon where it leaves room, so the partner stays on it', () => {
    // A 3.5 m track along y = 0, with the route 0.5 m north of its centre:
    // 2.25 m of road right of the line, 1.25 m left of it.
    const track = withRoads([{ cls: 1, width: 3.5, flags: 0, points: Float32Array.from([-390, 0, 390, 0]) }]);
    const r = routeThrough(track, [-300, 0.5], [300, 0.5]);
    const at = seat(r, 3).map((b, i) => placeBot(track, r, b.state, i, createBotDriverMemo(), DT));
    expect(at[0].slotM).toBeCloseTo(1.2, 4);
    expect(at[1].slotM).toBeCloseTo(-1.15, 4);
    expect(at[2].slotM).toBeCloseTo(2.15, 4);
    // Within the drawn ribbon (±1.75 m) less the margin; the spherical lane
    // shift and the ellipsoidal projection differ by ~0.1 %.
    for (const p of at) expect(Math.abs(p.placement.worldY)).toBeLessThanOrEqual(1.75 - PARTNER_EDGE_MARGIN_M + 0.01);
  });

  it('rides the verge where a 1.5 m path cannot seat a partner 0.9 m from the rider and the partner inside it', () => {
    // A 1.5 m path along y = 0 with the route 0.3 m north of its centre
    // (Tiber's paths run 0.2–0.4 m off it): 1.05 m of path right of the
    // line, 0.45 m left. The clamp alone drew partner 1 0.35 m from the
    // rider and partner 2 on partner 0.
    const narrow = withRoads([path(-390, 0, 390, 0)]);
    const r = routeThrough(narrow, [-300, 0.3], [300, 0.3]);
    const frame = createRideFrame();
    driveRideFrame(frame, createRideDriverMemo(), narrow, {
      route: r, distance: 0, speed: 0, grade: 0, cadence: 0, power: 0, rideState: 'ready',
      steer: 0, override: null, lookAheadM: 12, dt: DT, timeS: 0,
    });
    const rider = frame.placement!.position;
    const at = seat(r, 3).map((b, i) => placeBot(narrow, r, b.state, i, createBotDriverMemo(), DT));
    // Partner 0 keeps its clamp on the path; 1 and 2 ride the verge.
    expect(at.map((p) => p.slotM)).toEqual([expect.closeTo(0.95, 4), expect.closeTo(-PARTNER_SLOT_FLOOR_M, 4), expect.closeTo(1.85, 4)]);
    expect(Math.abs(at[0].placement.worldY)).toBeLessThanOrEqual(0.75 - PARTNER_EDGE_MARGIN_M + 0.01);
    const pos = at.map((p) => p.placement.position);
    for (const p of pos) expect(Math.hypot(p.x - rider.x, p.z - rider.z)).toBeGreaterThanOrEqual(PARTNER_SLOT_FLOOR_M - 0.01);
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) expect(Math.hypot(pos[i].x - pos[j].x, pos[i].z - pos[j].z)).toBeGreaterThanOrEqual(PARTNER_SLOT_FLOOR_M - 0.01);
    }
  });

  it('keeps its slot where a side road crosses the route (the Tiber start, 8.5 m in)', () => {
    // A 1.5 m side path along x = 0 crossing a 7 m road along y = 0; the
    // route runs east 1 m north of the road's centre, starting 0.5 m past
    // the path. The path's centreline is nearer the start than the road's:
    // measured across the heading it would leave 0.25 m right of the line.
    const cross = withRoads([
      { cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, 0, 390, 0]) },
      { cls: 2, width: 1.5, flags: 0, points: Float32Array.from([0, -190, 0, 190]) },
    ]);
    const r = routeThrough(cross, [0.5, 1], [300, 1]);
    const at = seat(r, 2).map((b, i) => placeBot(cross, r, b.state, i, createBotDriverMemo(), DT));
    expect(at[0].slotM).toBeCloseTo(1.2, 6);
    expect(at[1].slotM).toBeCloseTo(-1.2, 6);
  });

  it('measures the slot across the FILTERED heading, not the raw route bearing', () => {
    // A bot whose raw heading points north on an eastbound route: the filter
    // starts from the route's wide-chord heading, so the slot stays south.
    const [b0] = seat(east, 1);
    const p = placeBot(sw, east, { ...b0.state, heading: 0 }, 0, createBotDriverMemo(), DT).placement;
    expect(p.worldY).toBeCloseTo(-1.2, 2);
    expect(p.heading).toBeCloseTo(Math.PI / 2, 2);
  });

  it('stands the partner on the ground it is given', () => {
    const [b0] = seat(east, 1);
    const p = placeBot(sw, east, b0.state, 0, createBotDriverMemo(), DT, () => 123.25).placement;
    expect(p.position.y).toBe(123.25);
    expect(p.pitch).toBe(0);
  });

  it('eases a partner over where the road narrows: never faster than 2.5 m/s sideways, settled within 1.5 s', () => {
    // A 7 m road along y = 0 that becomes a 1.5 m path at x = 0.
    const narrows = withRoads([{ cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, 0, 0, 0]) }, path(0, 0, 390, 0)]);
    const r = routeThrough(narrows, [-200, 0], [300, 0]);
    expect(PARTNER_SLOT_MAX_RATE_MPS).toBe(2.5);
    for (const [i, wide, narrow] of [[0, 1.2, 0.9], [1, -1.2, -0.9], [2, 2.4, 1.8]]) {
      const frames = ride(narrows, r, i, 150, 260);
      expect(frames[0].slotM).toBeCloseTo(wide, 9);
      expect(maxStep(frames)).toBeLessThanOrEqual(PARTNER_SLOT_MAX_RATE_MPS * DT + 1e-9);
      // On the path from x = 3.5 (past the road's end cap); 1.5 s later the partner is in its narrow slot.
      const settled = frames.filter((f) => f.lineX > 3.5 + 8 * 1.5);
      expect(settled.length).toBeGreaterThan(60);
      for (const f of settled) expect(f.slotM).toBeCloseTo(narrow, 2);
      // Never across the line on the way.
      for (const f of frames) expect(f.slotM * Math.sign(wide)).toBeGreaterThan(0);
    }
  });

  it('seats a partner in its new clamp on the first frame after a jump of more than 40 m (a seek, Ride again), and eases one of 40 m', () => {
    // A 1.5 m path along y = 0 up to x = 0, then a 7 m road. The route runs
    // east from x = −200 (distance d is at x = d − 200): on the path the
    // slots are 0.9, −0.9 and 1.8 m, the road leaves them at 1.2, −1.2 and 2.4 m.
    // Review of PR #55 @fc70772 (Z9): placeBot passing a frozen distance to
    // stepPartnerSlot left every jump eased in from the old slot for ~1 s.
    const world = withRoads([path(-390, 0, 0, 0), { cls: 0, width: 7, flags: 0, points: Float32Array.from([0, 0, 390, 0]) }]);
    const r = routeThrough(world, [-200, 0], [300, 0]);
    expect(YAW_SNAP_M).toBe(40);
    const cap = PARTNER_SLOT_MAX_RATE_MPS * DT + 1e-9;
    const narrow = [0.9, -0.9, 1.8];
    const wide = [1.2, -1.2, 2.4];
    for (const i of [0, 1, 2]) {
      // One memo for the whole ride, as Rider.tsx keeps one per partner.
      const memo = createBotDriverMemo();
      const at = (d: number) => {
        const p = sampleRouteAtDistance(r, d);
        return placeBot(world, r, { distance: d, speed: 8, heading: headingAt(r, d), lat: p.lat, lon: p.lon }, i, memo, DT).slotM;
      };
      for (const f of ride(world, r, i, 100, 120, 8, memo)) expect(f.slotM).toBeCloseTo(narrow[i], 4);
      // Forward 180 m from the path onto the road (a seek): the road's slot at once.
      expect(at(300)).toBeCloseTo(wide[i], 9);
      for (const f of ride(world, r, i, 300, 320, 8, memo)) expect(f.slotM).toBeCloseTo(wide[i], 9);
      // Back to the start from the road (Ride again, −320 m): the path's clamp at once.
      expect(at(0)).toBeCloseTo(narrow[i], 4);
      // Back 50 m from the road (x = 40) onto the path (x = −10): a backward seek.
      expect(at(250)).toBeCloseTo(wide[i], 9);
      expect(at(240)).toBeCloseTo(wide[i], 9);
      expect(at(190)).toBeCloseTo(narrow[i], 4);
      // A jump of exactly 40 m from the path onto the road is no seek: the
      // partner drifts over at no more than 2.5 m/s and settles in 1.5 s.
      const before = at(170);
      expect(before).toBeCloseTo(narrow[i], 4);
      const first = at(210);
      expect(Math.abs(first - before)).toBeLessThanOrEqual(cap);
      expect((first - before) * Math.sign(wide[i] - narrow[i])).toBeGreaterThan(0);
      const frames = ride(world, r, i, 210 + 8 * DT, 240, 8, memo);
      expect(Math.abs(frames[0].slotM - first)).toBeLessThanOrEqual(cap);
      expect(maxStep(frames)).toBeLessThanOrEqual(cap);
      for (const f of frames.filter((f) => f.d > 210 + 8 * 1.5)) expect(f.slotM).toBeCloseTo(wide[i], 2);
    }
  });

  it("keeps the clamp through a sharp bend in a narrow path: the ribbon follows the route's bearing, not the lagging heading", () => {
    // A 1.5 m path east to (0, 0), then turning 120° right (SSW); the route
    // rides its centreline, so the slots are ±0.9 m. The drawn heading
    // trails the corner by up to ~65° here, so judged against it the path
    // would drop out for ~4 m and the slot would drift toward its unclamped 1.2 m.
    const dir = 210 * DEG;
    const corner = withRoads([path(-200, 0, 0, 0, 180 * Math.sin(dir), 180 * Math.cos(dir))]);
    const r = routeVia(corner, [-200, 0], [0, 0], [150 * Math.sin(dir), 150 * Math.cos(dir)]);
    for (const [i, slot] of [[0, 0.9], [1, -0.9]]) {
      const frames = ride(corner, r, i, 150, 260);
      for (const f of frames) expect(f.slotM).toBeCloseTo(slot, 4);
    }
  });

  it('draws the slot across the FILTERED heading through a U-turn, and switches sides only as the heading comes round', () => {
    // Out and back along a 1.5 m E–W path, the route 0.5 m north of its
    // centre: eastbound 1.25 m of path lie right of the line (south), 0.25 m
    // left; westbound the other way round. At the turn the route bearing
    // flips at once while the drawn heading takes ~1.3 s to come round (the
    // YawFilter's 140°/s cap): the frames that tell the drawn heading from
    // the route's.
    const ew = withRoads([path(-390, 0, 390, 0)]);
    const r = routeVia(ew, [-200, 0.5], [100, 0.5], [-200, 0.5]);
    // On the narrow side the partner is floored at 0.9 m; partner 2 rides
    // 0.9 m beyond partner 0.
    const eastbound = [1.15, -0.9, 2.05];
    const westbound = [0.9, -1.15, 1.8];
    const all: Frame[][] = [];
    for (const i of [0, 1, 2]) {
      const frames = ride(ew, r, i, 250, 380);
      all.push(frames);
      let early = 0;
      let late = 0;
      for (const f of frames) {
        const ox = f.x - f.lineX;
        const oy = f.y - f.lineY;
        const len = Math.hypot(ox, oy);
        // The offset is the slot, across the drawn heading: perpendicular to
        // it (the spherical lane shift and the projection differ by < 0.5 %).
        expect(Math.abs(len - Math.abs(f.slotM))).toBeLessThanOrEqual(0.005 * Math.max(1, len));
        expect(Math.abs(ox * Math.sin(f.heading) + oy * Math.cos(f.heading))).toBeLessThanOrEqual(0.01 * Math.max(1, len));
        // Past the turn (300 m) with the drawn heading still within 45° of
        // east, the partner keeps its eastbound clamp: the span is read
        // across the drawn heading, not the flipped route bearing.
        const eastness = Math.sin(f.heading);
        if (f.d > 300 && eastness > Math.SQRT1_2) {
          early++;
          expect(f.slotM).toBeCloseTo(eastbound[i], 4);
        }
        // Once it points within 10° of west the partner has settled into its westbound clamp.
        if (f.d > 300 + 8 * 2.5 && eastness < -Math.cos(10 * DEG)) {
          late++;
          expect(f.slotM).toBeCloseTo(westbound[i], 2);
        }
        // Never nearer the line than the floor, even while the heading pivots.
        expect(Math.abs(f.slotM)).toBeGreaterThanOrEqual(PARTNER_SLOT_FLOOR_M - 1e-9);
      }
      expect(early).toBeGreaterThan(10);
      expect(late).toBeGreaterThan(300);
    }
    // Partners 0 and 2 share a side: 0.9 m apart or more on every frame of the turn.
    for (let k = 0; k < all[0].length; k++) {
      expect(Math.hypot(all[0][k].x - all[2][k].x, all[0][k].y - all[2][k].y)).toBeGreaterThanOrEqual(PARTNER_SLOT_FLOOR_M - 0.01);
    }
  });
});
