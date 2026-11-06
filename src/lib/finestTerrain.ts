/**
 * The finest terrain height near the rider, fetched along the ride for the
 * photoreal globe stand-in (lib/avatar createGroundSampler, GLOBE_STANDIN_M).
 *
 * The globe's own reading (`globe.getHeight`) is the deepest tile LOADED. A
 * hidden globe selects no tiles, so once it has been hidden for a while (the
 * mesh is the one drawn ground, renderers/cesium/globeGate) it keeps whatever
 * coarse tile it last loaded along the way. Lugano–Melide 7.59–7.61 km,
 * reached by riding: 317.1, 323.6 and 337.9 m in three runs, where the finest
 * World Terrain is 321.3–321.6 m and the shore road 321.5 m. Drawn again, the
 * globe refines to its finest, so that is what tells whether it would stand
 * near the road.
 *
 * Fetched in one batch from where the rider is to FINEST_AHEAD_M ahead along
 * the way it moves (one terrain tile covers hundreds of metres, so a batch is
 * usually one request), one batch at a time.
 *
 * Engine-free: the fetch is injected (cesiumUtils sceneFinestTerrain wraps
 * Cesium's sampleTerrainMostDetailed).
 */

/** A batch reaches this far ahead along the way the rider moves (m)… */
export const FINEST_AHEAD_M = 32;
/** …a point every this many metres. */
export const FINEST_STEP_M = 4;
/** A height fetched answers for spots within this of it (m). */
export const FINEST_NEAR_M = 3;
/** A batch that failed (no terrain yet, a tile error) is tried again after this (ms). */
export const FINEST_RETRY_MS = 1_000;
/** Heights kept (oldest dropped first). */
export const FINEST_KEEP = 256;

/** Finest heights at [lon, lat] points (undefined where none). */
export type FinestFetch = (points: [number, number][]) => Promise<(number | undefined)[]>;

export interface FinestTerrain {
  /** The finest height fetched within {@link FINEST_NEAR_M} of lon/lat (undefined if none yet). */
  near(lon: number, lat: number): number | undefined;
  /**
   * Fetch the finest heights at lon/lat and ahead of it, the way the rider
   * came from fromLon/fromLat (NaN: only here), unless one is already near or
   * a batch is on its way.
   */
  want(lon: number, lat: number, fromLon: number, fromLat: number, nowMs: number): void;
}

/** Nothing to fetch from (flat globe, no terrain provider): the loaded globe decides. */
export const NO_FINEST_TERRAIN: FinestTerrain = { near: () => undefined, want: () => undefined };

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

function metres(lon: number, lat: number, lon2: number, lat2: number): number {
  return Math.hypot((lon - lon2) * mPerDegLon(lat), (lat - lat2) * M_PER_DEG_LAT);
}

export function createFinestTerrain(fetch: FinestFetch): FinestTerrain {
  const got: { lon: number; lat: number; h: number }[] = [];
  let busy = false;
  let failedAt = -Infinity;
  const near = (lon: number, lat: number): number | undefined => {
    let best: number | undefined;
    let bestM = FINEST_NEAR_M;
    for (const p of got) {
      const m = metres(lon, lat, p.lon, p.lat);
      if (m <= bestM) {
        bestM = m;
        best = p.h;
      }
    }
    return best;
  };
  return {
    near,
    want(lon, lat, fromLon, fromLat, nowMs) {
      if (busy || nowMs - failedAt < FINEST_RETRY_MS || near(lon, lat) !== undefined) return;
      const points: [number, number][] = [[lon, lat]];
      const moved = Number.isFinite(fromLon) && Number.isFinite(fromLat) ? metres(lon, lat, fromLon, fromLat) : 0;
      if (moved > 0.5) {
        // Metres east and north per metre along the way the rider moves.
        const e = ((lon - fromLon) * mPerDegLon(lat)) / moved;
        const n = ((lat - fromLat) * M_PER_DEG_LAT) / moved;
        for (let d = FINEST_STEP_M; d <= FINEST_AHEAD_M; d += FINEST_STEP_M) {
          points.push([lon + (e * d) / mPerDegLon(lat), lat + (n * d) / M_PER_DEG_LAT]);
        }
      }
      busy = true;
      fetch(points).then(
        (hs) => {
          busy = false;
          let any = false;
          hs.forEach((h, i) => {
            if (h === undefined || !Number.isFinite(h) || !points[i]) return;
            any = true;
            got.push({ lon: points[i][0], lat: points[i][1], h });
          });
          if (got.length > FINEST_KEEP) got.splice(0, got.length - FINEST_KEEP);
          if (!any) failedAt = nowMs;
        },
        () => {
          busy = false;
          failedAt = nowMs;
        },
      );
    },
  };
}
