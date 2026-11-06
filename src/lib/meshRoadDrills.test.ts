/**
 * The mesh road filter (lib/avatar createMeshRoadFilter) on stretches cut from
 * the drilled photoreal mesh (t_148e9796, cat-bed): every up-facing surface
 * down the vertical every half metre, top first, as the rider's tiles drew
 * them, with the globe there (World Terrain as loaded) and the road line (the
 * surface that runs on; interpolated where none is drawn). Rows live in
 * meshRoadDrills.json: [metres along, globe, road, surfaces…].
 *
 * Each stretch pins a rule of the filter that moved the drilled replay (the
 * rider over or under the road by more than a metre somewhere along it) and
 * that no other test reached (PR #76 review, mutants R9–R42): the rider is
 * judged where the road is drawn, read at the spacings and phases a ride
 * reads it at, from a jump (nothing to go on from) a few tens of metres
 * before, which is where the sampler stands after a cut or a slow start too.
 */
import { describe, expect, it } from 'vitest';

import { createMeshRoadFilter, MESH_OVER_TERRAIN_MAX_M, MESH_UNDER_ROUTE_MAX_M } from '@/lib/avatar';

import drills from './meshRoadDrills.json';

type Row = number[];
interface Drill {
  route: string;
  drill: string;
  step: number;
  rows: Row[];
}
const D = drills as Record<string, Drill>;

const LON = -81.5;
const at = (m: number) => 41 + m / 110_540;
const metres = (lat: number) => (lat - 41) * 110_540;

/** The row nearest m (rows sorted by metres). */
function rowAt(rows: Row[], m: number): Row {
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= m) lo = mid;
    else hi = mid;
  }
  return Math.abs(rows[hi][0] - m) < Math.abs(rows[lo][0] - m) ? rows[hi] : rows[lo];
}

interface Read {
  m: number;
  /** What the rider stands on: the filter's road, else the globe. */
  shown: number;
  road: number;
  globe: number;
  /** The road is one of the surfaces drawn here. */
  drawn: boolean;
  status: string;
}

/**
 * The filter rolled along a drilled stretch, read every `spacing` m from
 * `phase` on, from a jump, with the sampler's bounds: at most
 * MESH_OVER_TERRAIN_MAX_M over the higher of the globe and the road held, at
 * least MESH_UNDER_ROUTE_MAX_M under the globe.
 */
function ride(rows: Row[], spacing: number, phase: number): Read[] {
  const f = createMeshRoadFilter();
  const readAt = (_lon: number, lat: number, under?: number) => {
    const hits = rowAt(rows, metres(lat)).slice(3);
    return under === undefined ? hits[0] : hits.find((h) => h <= under);
  };
  const out: Read[] = [];
  for (let m = rows[0][0] + phase; m <= rows[rows.length - 1][0]; m += spacing) {
    const [, globe, road, ...hits] = rowAt(rows, m);
    const ceiling = Math.max(globe, f.road() ?? -Infinity) + MESH_OVER_TERRAIN_MAX_M;
    const got = f.next(hits[0], LON, at(m), ceiling, readAt, globe - MESH_UNDER_ROUTE_MAX_M, globe);
    out.push({ m, shown: got ?? globe, road, globe, drawn: hits.some((h) => Math.abs(h - road) < 0.01), status: f.status() });
  }
  return out;
}

/** Every ride over `name` at the given spacings, at every phase the rows allow. */
function rides(name: string, spacings: number[]): { at: string; reads: Read[] }[] {
  const { rows, step } = D[name];
  const out: { at: string; reads: Read[] }[] = [];
  for (const s of spacings) {
    for (let o = 0; o < s; o += step) out.push({ at: `${name} read ${s} m apart from ${rows[0][0] + o} m`, reads: ride(rows, s, o) });
  }
  return out;
}

const EVERY = [2, 3, 4, 5, 6, 7, 8];

/** Where the road is drawn in [from, to], the rider rides it (within 0.3 m), on every ride given. */
function onTheRoad(ridden: { at: string; reads: Read[] }[], from = -Infinity, to = Infinity) {
  let judged = 0;
  for (const { at: where, reads } of ridden) {
    for (const r of reads) {
      if (!r.drawn || r.m < from || r.m > to) continue;
      judged++;
      expect(Math.abs(r.shown - r.road), `${where}, at ${r.m} m (${r.status})`).toBeLessThanOrEqual(0.3);
    }
  }
  expect(judged).toBeGreaterThan(0);
}

describe('the mesh road filter on drilled stretches: each rule that moved the drilled replay', () => {
  it('the fixtures are as drilled: every half metre, a globe, a road and at least one surface on every row', () => {
    for (const [name, d] of Object.entries(D)) {
      expect(d.rows.length, name).toBeGreaterThan(40);
      for (let i = 0; i < d.rows.length; i++) {
        expect(d.rows[i].length, `${name} ${i}`).toBeGreaterThanOrEqual(4);
        if (i) expect(d.rows[i][0] - d.rows[i - 1][0], `${name} ${i}`).toBeCloseTo(d.step, 6);
      }
    }
  });

  it('Lugano–Melide 7.57–7.63 km: under a structure 6 m over the shore road, a rise within the climb allowance is not climbed onto', () => {
    // 55 m of a structure 5.5–7 m over the road (crowns to 16 m), nothing
    // drawn under it, the globe within half a metre of the road. Read some
    // tens of metres in, the allowance has grown past 6 m; climbsOnto still
    // refuses the top: more than OVERHANG_MIN_M over the terrain the road was
    // on (without that refusal the rider rides it, 6.4 m up).
    onTheRoad(rides('lugano7570', EVERY));
  });

  it('Cuyahoga 6.10–6.14 km: crown tops 6–18 m over the towpath are structures, and a run of them is no deck', () => {
    // From a jump, with no road to go on from: a top over STRUCTURE_M (6 m)
    // above the terrain is a crown or a deck, ridden only as a deck once it
    // runs on smooth (DECK_STEP_M + DECK_GRADE a metre). Counting only tops
    // 10 m up as structures, or skipping the smoothness check, puts the rider
    // on the crowns, up to 13 m over the towpath.
    onTheRoad(rides('cuyahoga6100', EVERY));
  });

  it('Cuyahoga 2.81–2.84 km: under crowns 25 m up the towpath is read down from where the road can be, not from under the top', () => {
    // The towpath is drawn under the crowns almost everywhere, with branch
    // layers between. Over the road, the read starts at the highest the road
    // can have climbed (UNDER_GRADE), not 2 m under the crown; from a jump
    // it starts near the terrain (OVERHANG_MIN_M over it). Reading from under
    // the crown finds a branch layer first and runs out of reads
    // (UNDER_READS) before the towpath.
    onTheRoad(rides('cuyahoga2815', EVERY));
  });

  it('Cuyahoga 2.39–2.43 km: the edge of a bush 6–7 m over the towpath is not a ramp (read 5 and 7 m apart)', () => {
    // Short runs of bushes over the towpath, drawn under them. A top rising
    // steeper than a road climbs is looked under (the steep-top clause), and
    // a rise between two reads is a ramp only at RAMP_GRADE a metre or less.
    // Judged from 2426 m, past the first bushes the jump starts among.
    onTheRoad(rides('cuyahoga2390', EVERY), 2426);
  });

  it('Chengdu 6.82–6.91 km: back on the mesh road after 50 m of only coarse root-tile chords', () => {
    // 6832–6880 m reads the root tile's chord, 700–1,600 m under the road:
    // no mesh road, the road held. Where the road is drawn again (3 m over
    // the globe, rising from the terrain the road was last taken on), it is
    // taken: clause 2 of climbsOnto refuses only a climb further over the
    // terrain here than the road was over it there (without that comparison
    // the rider stays 5.8 m under the road).
    onTheRoad(rides('chengdu6820', EVERY), 6877.5);
  });

  it('Cuyahoga 10.53–10.60 km: a slope rising half a metre a metre over the towpath is looked under (UNDER_RISE_M)', () => {
    // The towpath is drawn the whole way; from 10545 m the top climbs away
    // from it at about 0.5 m per m, to 20 m over it. A rise of more than
    // UNDER_RISE_M is looked under (read 2 and 3 m apart a rise is 1–1.5 m);
    // looking under only from OVERHANG_RISE_M on, the rider follows the slope
    // up, 16 m over the towpath. Judged from 10549 m: the first read onto the
    // slope can still be taken (up to 2 m over, then back on the towpath).
    onTheRoad(rides('cuyahoga10530', EVERY), 10549);
  });

  it('Cuyahoga 6.41–6.42 km: a crown 9–11 m over the towpath is not climbed onto from the towpath', () => {
    // From the towpath (not on a structure) onto a crown top, steeper than a
    // road climbs from the road spots read in the last CLIMB_SPAN_M: clause 1
    // of climbsOnto refuses it, the towpath under it is taken. Read 3–8 m
    // apart at every phase, and 2 m apart on the odd metres. On the other
    // two phases read 2 m apart the rider climbs a low layer of the crown in
    // two steps at 6394–6396 m and is held on it, 5–6 m up, until 6414 m: a
    // residual the drilled replay counts in its up>1.
    const { rows } = D.cuyahoga6380;
    onTheRoad([...rides('cuyahoga6380', [3, 4, 5, 6, 7, 8]), { at: 'read 2 m apart from 6381 m', reads: ride(rows, 2, 1) }], 6411, 6422);
  });

  it('Cuyahoga 4.69–4.77 km: an edge of a crown found under it is no road to climb onto the crown from', () => {
    // At 4695–4696 m the mesh closes a crown down onto the towpath: read
    // there from under the crown, its edge (1.7 m over the towpath, 1.3 m a
    // metre) is the surface nearest the road, and it is taken. Then nothing
    // is drawn near the road under the crowns for 62 m, and at 4729–4737 m
    // the lowest layer of a crown is 5–6 m over the towpath with nothing
    // under it: under OVERHANG_MIN_M over the edge, so measured from the edge
    // it was ridden over, and the rider rode 5.6 m over the towpath for 24 m
    // (cat-bed, every build). Measured from the towpath before the edge
    // (climbsOnto's stepFrom) it is a climb onto a structure.
    //
    // Read up to GROUND_SAMPLE_MOVE_M apart (plus a frame's travel), as the
    // sampler reads. Read 6–8 m apart (a rider at speed under 10 fps), the
    // edge's 1.7 m is no steeper than a road climbs (CLIMB_GRADE) from the
    // last read, and the crown is still ridden.
    const ridden = rides('cuyahoga4670', [2, 3, 4, 5, 5.5]);
    let judged = 0;
    for (const { at: where, reads } of ridden) {
      for (const r of reads) {
        if (r.m < 4697 || r.m >= 4759) continue;
        judged++;
        expect(r.shown - r.road, `${where}, at ${r.m} m (${r.status})`).toBeLessThanOrEqual(1.5);
      }
    }
    expect(judged).toBeGreaterThan(0);
    // Where the towpath is drawn again, the rider is on it, not on a crown
    // layer between (167.7 m at 4760 m) measured from a crown taken.
    onTheRoad(ridden, 4759);
  });

  it('Cuyahoga 5.83–5.91 km: held on a road found under a crown that climbed too steeply, the towpath is looked for near the road before it', () => {
    // A bush 3–4 m over the towpath, read from under a crown, is the surface
    // nearest the road and is taken (unproven: it climbed steeper than a
    // road). Under the next crowns the towpath is drawn again, out of reach
    // under the bush or with a crown layer nearer the bush, and was found
    // only once the crowns ended: the rider was held 4 m over it for up to
    // 30 m. Looked for near the towpath before the bush first, it is found
    // where it is drawn. (Read 7 or 8 m apart, the stretch is still ridden
    // off the towpath in places, as it was before.)
    onTheRoad(rides('cuyahoga5826', [2, 3, 4, 5, 6]));
  });
});

