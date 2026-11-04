/**
 * Where a baked route actually runs: on a drawn road, in a tunnel, off every
 * road, or out on open water. A route the router sent over a boat line
 * (Locarno–Brissago once crossed Lago Maggiore for 3.6 km on the "Ascona -
 * Ronco" ferry) has to fail a test before it ships, not after a rider sees a
 * grey ribbon lying on the lake.
 *
 * Measured per route sample (`WorldRoute.s`, every `stepM` metres) against
 * the bundle's own layers:
 * - on a road: within `roadM` of a mapped road the renderer draws. Tunnels
 *   and steps aren't drawn; a route fill (`routeFill`, a surface the bake
 *   lays under a route where no mapped road is) is drawn but isn't a road,
 *   and would otherwise pave a lake crossing;
 * - in a tunnel: off every drawn road but within `roadM` of a tunnel;
 * - off road: neither;
 * - on water: off road and inside a water area polygon (lake, river, pond).
 *   Bridges and causeways carry a drawn road, so they are on a road.
 * Contiguous stretches come back as runs, so a test can bound their length.
 */

import type { RoadsLayer, WaterLayer, WorldRoute } from './loadWorld';

export interface RouteRun {
  /** Route distance where the run starts and ends (sample positions), metres. */
  fromM: number;
  toM: number;
  /** Ridden length the run covers: the samples' span plus one step. */
  lengthM: number;
}

export interface RouteSurface {
  id: string;
  /** Runs more than `roadM` from every mapped, drawn road, tunnels excluded. */
  offRoad: RouteRun[];
  /** Off-road runs inside a water area polygon. */
  onWater: RouteRun[];
}

/** Distance from a route sample to a road centreline that still counts as on it, metres. */
export const ROUTE_ON_ROAD_M = 12;

const CELL_M = 64;

interface SegmentGrid {
  segs: number[];
  cells: Map<number, number[]>;
}

const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

function segmentGrid(lines: Float32Array[]): SegmentGrid {
  const segs: number[] = [];
  const cells = new Map<number, number[]>();
  for (const p of lines) {
    for (let i = 0; i + 3 < p.length; i += 2) {
      const k = segs.length / 4;
      segs.push(p[i], p[i + 1], p[i + 2], p[i + 3]);
      const cx0 = Math.floor(Math.min(p[i], p[i + 2]) / CELL_M);
      const cx1 = Math.floor(Math.max(p[i], p[i + 2]) / CELL_M);
      const cy0 = Math.floor(Math.min(p[i + 1], p[i + 3]) / CELL_M);
      const cy1 = Math.floor(Math.max(p[i + 1], p[i + 3]) / CELL_M);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = cellKey(cx, cy);
          const list = cells.get(key);
          if (list) list.push(k);
          else cells.set(key, [k]);
        }
      }
    }
  }
  return { segs, cells };
}

/** Whether any segment of the grid passes within `r` (≤ CELL_M) of (x, y). */
function near(grid: SegmentGrid, x: number, y: number, r: number): boolean {
  const cx = Math.floor(x / CELL_M);
  const cy = Math.floor(y / CELL_M);
  const r2 = r * r;
  for (let i = cx - 1; i <= cx + 1; i++) {
    for (let j = cy - 1; j <= cy + 1; j++) {
      const list = grid.cells.get(cellKey(i, j));
      if (!list) continue;
      for (const k of list) {
        const ax = grid.segs[4 * k];
        const ay = grid.segs[4 * k + 1];
        const dx = grid.segs[4 * k + 2] - ax;
        const dy = grid.segs[4 * k + 3] - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
        const ex = ax + t * dx - x;
        const ey = ay + t * dy - y;
        if (ex * ex + ey * ey <= r2) return true;
      }
    }
  }
  return false;
}

interface WaterIndex {
  rings: Float32Array[][];
  boxes: Float64Array;
}

function waterIndex(water: WaterLayer): WaterIndex {
  const rings = water.areas.filter((a) => a.rings.length && a.rings[0].length >= 6).map((a) => a.rings);
  const boxes = new Float64Array(rings.length * 4);
  rings.forEach((rs, i) => {
    const o = rs[0];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k + 1 < o.length; k += 2) {
      x0 = Math.min(x0, o[k]);
      x1 = Math.max(x1, o[k]);
      y0 = Math.min(y0, o[k + 1]);
      y1 = Math.max(y1, o[k + 1]);
    }
    boxes.set([x0, y0, x1, y1], i * 4);
  });
  return { rings, boxes };
}

/** Even-odd over an area's outer ring and its holes. */
function insideWater(index: WaterIndex, x: number, y: number): boolean {
  for (let a = 0; a < index.rings.length; a++) {
    const b = index.boxes;
    if (x < b[4 * a] || y < b[4 * a + 1] || x > b[4 * a + 2] || y > b[4 * a + 3]) continue;
    let inside = false;
    for (const ring of index.rings[a]) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[2 * i + 1];
        const yj = ring[2 * j + 1];
        if (yi > y !== yj > y && x < ring[2 * i] + ((y - yi) / (yj - yi)) * (ring[2 * j] - ring[2 * i])) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

function runs(route: WorldRoute, flag: boolean[]): RouteRun[] {
  const out: RouteRun[] = [];
  let start = -1;
  for (let i = 0; i <= flag.length; i++) {
    if (i < flag.length && flag[i]) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const fromM = route.s[start];
      const toM = route.s[i - 1];
      out.push({ fromM, toM, lengthM: toM - fromM + route.stepM });
      start = -1;
    }
  }
  return out;
}

/** Off-road and on-water runs of each route, measured against the bundle's roads and water. */
export function routeSurfaces(
  routes: WorldRoute[],
  roads: RoadsLayer,
  water: WaterLayer,
  roadM = ROUTE_ON_ROAD_M,
): RouteSurface[] {
  const steps = roads.classes.indexOf('steps');
  const fill = roads.flags.routeFill ?? 0;
  const drawn = segmentGrid(
    roads.roads.filter((r) => !(r.flags & roads.flags.tunnel) && !(r.flags & fill) && r.cls !== steps).map((r) => r.points),
  );
  const tunnels = segmentGrid(roads.roads.filter((r) => r.flags & roads.flags.tunnel).map((r) => r.points));
  const lakes = waterIndex(water);
  return routes.map((route) => {
    const off: boolean[] = [];
    const wet: boolean[] = [];
    for (let i = 0; i < route.s.length; i++) {
      const x = route.x[i];
      const y = route.y[i];
      const o = !near(drawn, x, y, roadM) && !near(tunnels, x, y, roadM);
      off.push(o);
      wet.push(o && insideWater(lakes, x, y));
    }
    return { id: route.id, offRoad: runs(route, off), onWater: runs(route, wet) };
  });
}

/** Length of the longest run, metres (0 when there is none). */
export const longestRun = (r: RouteRun[]) => r.reduce((m, x) => Math.max(m, x.lengthM), 0);
