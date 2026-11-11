/**
 * Bridges as structures (bridgeDecks.ts): the deck surface meets the drawn
 * ground where it comes down to it, the ridden route stands on its decks and
 * only on those, and the structure is drawn where the deck stands clear.
 * Plus every shipped world baked with bridges: no route passes under a deck
 * with less than the bake's headroom, every ridden deck carries the rider,
 * walked every half metre of the line the rider follows the rider is on the
 * ground off its ridden spans and on that span's own deck on them, and no
 * deck kinks where pins fight.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readableWorldBundles } from '../../../tools/worldbake/worldBundles.mjs';
import { sampleAppRoute } from '../../../tools/worldbake/routeCoverage.mjs';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { Heightfield } from '@/lib/world/heightfield';
import { loadWorld, type BridgesLayer, type LoadedWorld, type RoadsLayer } from '@/lib/world/loadWorld';
import { createProjection } from '@/lib/world/projection';
import {
  AT_GRADE_BLEND_M,
  alongVertices,
  buildBridgeGeometry,
  deckPieces,
  deckTopAt,
  rideSurface,
  type DeckPiece,
} from './bridgeDecks';
import { buildRibbons, roadLines } from './roadRibbons';

/** Flat ground at 100 m, 21 × 21 nodes at 10 m from (0, 0) to (200, 200). */
const spec = { cols: 21, rows: 21, cellSize: 10, xMin: 0, yMax: 200, heightOffset: 100, heightScale: 1 / 64 };
const flat = new Heightfield(spec, new Uint16Array(21 * 21));

const FLAGS = { bridge: 1, tunnel: 2, unpaved: 4, oneway: 8 };

/**
 * Road 0: a bridge along y = 100 from x = 20 to x = 180, deck 108 m in the
 * middle, 100 m at both ends. Road 1: a footbridge along x = 100 crossing
 * over it, 6 m up. Road 2: a ground road along y = 40.
 */
function world(rides: BridgesLayer['rides'] = { ridden: [{ s0: 0, s1: 160, roads: [0] }] }): Pick<LoadedWorld, 'roads' | 'bridges'> {
  const roads: RoadsLayer = {
    classes: ['primary', 'footway'],
    flags: FLAGS,
    roads: [
      { cls: 0, width: 6, flags: FLAGS.bridge, points: Float32Array.from([20, 100, 100, 100, 180, 100]) },
      { cls: 1, width: 2, flags: FLAGS.bridge, points: Float32Array.from([100, 60, 100, 140]) },
      { cls: 0, width: 6, flags: 0, points: Float32Array.from([0, 40, 200, 40]) },
    ],
  };
  return {
    roads,
    bridges: {
      decks: [
        { road: 0, z: Float32Array.from([100, 108, 100]), thickness: 1.4, approach: false },
        { road: 1, z: Float32Array.from([116, 116]), thickness: 0.6, approach: false },
      ],
      piers: [{ x: 60, y: 100, ux: 1, uy: 0, halfAlong: 0.6, halfAcross: 1.8, bottom: 99.5, top: 102.6 }],
      rides,
    },
  };
}

describe('bridge decks', () => {
  it('reads the baked height along the piece', () => {
    const p = deckPieces(world()).get(0)!;
    expect(p.len).toBeCloseTo(160);
    expect(alongVertices(p.s, p.z, 40)).toBeCloseTo(104);
    expect(deckTopAt(p, 80, 100, 100, flat)).toBeCloseTo(108);
  });

  it('meets the drawn ground where it comes down to it, and never goes under it', () => {
    const p = deckPieces(world()).get(0)!;
    // The drawn LOD is 0.5 m over the heightfield here.
    const drawn = () => 100.5;
    // At the abutment (deck = heightfield) the deck is the drawn ground.
    expect(deckTopAt(p, 0, 20, 100, flat, drawn)).toBeCloseTo(100.5);
    // High up it ignores the drawn ground.
    expect(deckTopAt(p, 80, 100, 100, flat, drawn)).toBeCloseTo(108);
    // In between it blends over AT_GRADE_BLEND_M of height.
    const s = (AT_GRADE_BLEND_M / 2 / 8) * 80; // half the blend height up the ramp
    expect(deckTopAt(p, s, 20 + s, 100, flat, drawn)).toBeCloseTo(100 + AT_GRADE_BLEND_M / 2 + 0.25);
    // Under the drawn ground (a buried deck) it is the drawn ground.
    expect(deckTopAt(p, 0, 20, 100, flat, () => 103)).toBe(103);
  });

  it('puts the ridden route on its deck, and on the ground under any other deck', () => {
    const ground = (x: number, y: number) => flat.sampleHeight(x, y);
    const surface = rideSurface(world(), flat, 'ridden', ground);
    expect(surface(100, 100)).toBeCloseTo(108);
    // Within half-width + slack of the deck: still the deck.
    expect(surface(100, 104)).toBeCloseTo(108);
    // Off it: the ground, also under the footbridge the route doesn't ride.
    expect(surface(100, 120)).toBeCloseTo(100);
    expect(surface(100, 40)).toBeCloseTo(100);
    // A route that rides no deck is just the ground.
    expect(rideSurface(world(), flat, 'other', ground)).toBe(ground);
    expect(rideSurface({ roads: world().roads }, flat, 'ridden', ground)).toBe(ground);
  });

  it('draws the deck ribbon at the baked heights, a ground road on the ground', () => {
    const w = world();
    const lines = roadLines(w.roads, deckPieces(w));
    expect(lines[0].deck?.road).toBe(0);
    expect(lines[2].deck).toBeUndefined();
    const data = buildRibbons(flat, [lines[0]], { maxSegM: 10, lift: 0, originX: 0, originZ: 0 });
    const ys = Array.from({ length: data.vertexCount }, (_, i) => data.positions[i * 3 + 1]);
    expect(Math.max(...ys)).toBeCloseTo(108);
    expect(Math.min(...ys)).toBeCloseTo(100);
  });

  it('draws slab, parapets and piers where the deck stands clear, nothing under a landed approach', () => {
    const w = world();
    const pieces = [...deckPieces(w).values()];
    const opts = { maxSegM: 20, originX: 0, originZ: 0 };
    const full = buildBridgeGeometry(flat, pieces, w.bridges!.piers, opts);
    expect(full.vertexCount).toBeGreaterThan(0);
    expect(full.indices.length % 3).toBe(0);
    // Lowest: the slab underside at an abutment, buried in the ground there.
    const ys = Array.from({ length: full.vertexCount }, (_, i) => full.positions[i * 3 + 1]);
    expect(Math.min(...ys)).toBeCloseTo(100 - 0.02 - 1.4);
    expect(Math.max(...ys)).toBeCloseTo(116 - 0.02 + 1); // the footbridge parapet
    const atGrade: DeckPiece = { ...pieces[0], z: Float32Array.from([100, 100, 100]) };
    const parapetsOnly = buildBridgeGeometry(flat, [atGrade], [], opts);
    const landed = buildBridgeGeometry(flat, [{ ...atGrade, approach: true }], [], opts);
    expect(parapetsOnly.vertexCount).toBeGreaterThan(0);
    expect(landed.vertexCount).toBe(0);
  });
});

/** Bundles baked with bridges as structures (manifest generator.bridges). */
const BUNDLES = readableWorldBundles().filter((b: { manifestPath: string }) => {
  const m = JSON.parse(readFileSync(b.manifestPath, 'utf8'));
  return m.generator?.bridges === true;
});

/** The bake's DECK_HEADROOM_M (tools/worldbake/bridges.mjs) less its 0.15 m tolerance. */
const MIN_HEADROOM_M = 4.35;
/** Off its ridden decks the rider never stands more than this above the ground (bake: footprintConflicts tolM). */
const OFF_DECK_TOL_M = 0.3;
/** The line the rider follows is walked this often, metres. */
const WALK_M = 0.5;
/** Pins fight on a deck: its ribbon changes more than KINK_RISE_M within KINK_RUN_M, standing over KINK_ABOVE_M up (bake: deckKinks). */
const KINK_RUN_M = 6;
const KINK_RISE_M = 2;
const KINK_ABOVE_M = 1;
const KINK_STRAIGHT_M = 0.15;

/** The worst window of a deck piece by the bake's kink rule; null when straight end to end or no window qualifies. */
function worstKink(p: DeckPiece, hf: Heightfield): { s: number; riseM: number; aboveM: number } | null {
  const z0 = p.z[0];
  const z1 = p.z[p.z.length - 1];
  if (p.len <= 0 || Array.from(p.s).every((s, k) => Math.abs(p.z[k] - (z0 + ((z1 - z0) * s) / p.len)) <= KINK_STRAIGHT_M)) return null;
  const n = Math.max(1, Math.ceil(p.len / 0.5));
  const S: number[] = [];
  const Z: number[] = [];
  const A: number[] = [];
  for (let k = 0; k <= n; k++) {
    const s = (p.len * k) / n;
    let j = 1;
    while (j < p.s.length - 1 && p.s[j] < s) j++;
    const t = p.s[j] > p.s[j - 1] ? Math.min(1, Math.max(0, (s - p.s[j - 1]) / (p.s[j] - p.s[j - 1]))) : 0;
    const x = p.xy[2 * j - 2] + (p.xy[2 * j] - p.xy[2 * j - 2]) * t;
    const y = p.xy[2 * j - 1] + (p.xy[2 * j + 1] - p.xy[2 * j - 1]) * t;
    const z = alongVertices(p.s, p.z, s);
    S.push(s);
    Z.push(z);
    A.push(z - hf.sampleHeight(x, y));
  }
  let worst: { s: number; riseM: number; aboveM: number } | null = null;
  for (let a = 0; a < n; a++) {
    let hi = -Infinity;
    let lo = Infinity;
    let above = -Infinity;
    for (let b = a; b <= n && S[b] - S[a] <= KINK_RUN_M + 1e-9; b++) {
      hi = Math.max(hi, Z[b]);
      lo = Math.min(lo, Z[b]);
      above = Math.max(above, A[b]);
    }
    if (above > KINK_ABOVE_M && hi - lo > KINK_RISE_M && (!worst || hi - lo > worst.riseM)) worst = { s: S[a], riseM: hi - lo, aboveM: above };
  }
  return worst;
}

describe('shipped worlds with bridges', () => {
  it('include the Ohio worlds', () => {
    // Remote worlds are read once their layers are on disk (fetchPublished.mjs):
    // CI fetches them and requires them; a fresh clone without them skips them.
    if (process.env.VELO_REQUIRE_REMOTE_WORLDS !== '1') return;
    expect(BUNDLES.map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining(['cleveland-lakefront', 'ohio-erie-towpath']));
  });
});

describe.each(BUNDLES.map((b: { id: string; dir: string }) => [b.id, b.dir]))('shipped world %s', (id, dir) => {
  const diskFetch = async (url: string) => {
    try {
      return new Response(readFileSync(join(dir as string, url.replace(/^.*\//, ''))), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  };

  it('keeps headroom over every route passing under a deck, and carries the rider on every deck it rides', async () => {
    const w = await loadWorld(`/worlds/${id}/`, { fetch: diskFetch });
    const pieces = deckPieces(w);
    const hf = w.heightfield;
    const ground = (x: number, y: number) => hf.sampleHeight(x, y);
    for (const r of w.routes) {
      const ridden = new Set((w.bridges!.rides[r.id] ?? []).flatMap((x) => x.roads));
      const surface = rideSurface(w, hf, r.id, ground, pieces);
      // On a ridden span the rider stands on the deck the bake measured.
      for (const span of w.bridges!.rides[r.id] ?? []) {
        for (let i = 0; i < r.s.length; i++) {
          if (r.s[i] < span.s0 || r.s[i] > span.s1) continue;
          expect(Math.abs(surface(r.x[i], r.y[i]) - r.h[i]), `${r.id} at ${r.s[i]} m`).toBeLessThan(0.05);
        }
      }
      // Under every other deck: headroom.
      for (const [road, p] of pieces) {
        if (ridden.has(road)) continue;
        for (let i = 1; i < r.s.length; i++) {
          for (let k = 0; k + 1 < p.s.length; k++) {
            const ax = r.x[i - 1], ay = r.y[i - 1], bx = r.x[i], by = r.y[i];
            const cx = p.xy[k * 2], cy = p.xy[k * 2 + 1], dx = p.xy[k * 2 + 2], dy = p.xy[k * 2 + 3];
            const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
            if (Math.abs(den) < 1e-9) continue;
            const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
            const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
            const top = alongVertices(p.s, p.z, p.s[k] + (p.s[k + 1] - p.s[k]) * u);
            const routeH = surface(x, y);
            // A landed approach crossing at grade is a junction, not an underpass.
            if (p.approach && top - ground(x, y) < 0.3 && Math.abs(top - routeH) < 0.6) continue;
            const s = r.s[i - 1] + (r.s[i] - r.s[i - 1]) * t;
            expect(top - p.thickness - routeH, `${r.id} under road ${road} at ${s.toFixed(0)} m`).toBeGreaterThanOrEqual(MIN_HEADROOM_M);
          }
        }
      }
    }
  }, 60_000);

  it('walked every half metre of the line the rider follows: on the ground off its ridden spans, on that span’s own deck on them', async () => {
    const w = await loadWorld(`/worlds/${id}/`, { fetch: diskFetch });
    const pieces = deckPieces(w);
    const hf = w.heightfield;
    const ground = (x: number, y: number) => hf.sampleHeight(x, y);
    const projection = createProjection(w.manifest.projection);
    const bad: string[] = [];
    for (const r of w.routes) {
      const spans = w.bridges!.rides[r.id] ?? [];
      const surface = rideSurface(w, hf, r.id, ground, pieces);
      // The same reading over one span's decks only.
      const own = spans.map((span) => rideSurface({ roads: w.roads, bridges: { ...w.bridges!, rides: { [r.id]: [span] } } }, hf, r.id, ground, pieces));
      const line = sampleAppRoute(SCENIC_ROUTE_GEOMETRY[r.id].points, projection, WALK_M);
      let off = { s: 0, m: 0 };
      let on = { s: 0, m: 0 };
      for (let i = 0; i < line.s.length; i++) {
        const x = line.x[i];
        const y = line.y[i];
        const s = line.s[i];
        const si = spans.findIndex((sp) => s >= sp.s0 && s <= sp.s1);
        if (si < 0) {
          const m = surface(x, y) - ground(x, y);
          if (m > off.m) off = { s, m };
        } else {
          const m = Math.abs(surface(x, y) - own[si](x, y));
          if (m > on.m) on = { s, m };
        }
      }
      if (off.m > OFF_DECK_TOL_M) bad.push(`${r.id}: ${off.m.toFixed(2)} m above the ground at ${off.s.toFixed(1)} m, off its ridden spans`);
      if (on.m > OFF_DECK_TOL_M) bad.push(`${r.id}: ${on.m.toFixed(2)} m off its span's own deck at ${on.s.toFixed(1)} m (another ridden deck is nearer)`);
    }
    expect(bad).toEqual([]);
  }, 60_000);

  it('has no deck where pins fight (its ribbon never changes more than 2 m within 6 m standing over 1 m up, unless straight end to end)', async () => {
    const w = await loadWorld(`/worlds/${id}/`, { fetch: diskFetch });
    const kinks = [...deckPieces(w)]
      .map(([road, p]) => [road, worstKink(p, w.heightfield)] as const)
      .filter(([, k]) => k)
      .map(([road, k]) => `road ${road}: ${k!.riseM.toFixed(2)} m within 6 m at ${k!.s.toFixed(1)} m, ${k!.aboveM.toFixed(2)} m up`);
    expect(kinks).toEqual([]);
  }, 60_000);
});
