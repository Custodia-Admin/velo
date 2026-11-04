/**
 * Has the ground under a waiting rider streamed in at full detail?
 *
 * World Terrain refines in steps while a ride loads. A coarse tile's chord
 * sits tens to hundreds of metres off the real ground (948 m over a 329 m
 * Lugano shore, measured), and a rider that sets off on it drops onto the
 * road seconds later. Nor does "the height held still" prove anything: the
 * route-elevation fallback holds still while no tile exists at all.
 *
 * The test: the globe the GPU draws under the rider matches the most detailed
 * terrain the provider has there (sampleTerrainMostDetailed, fetched once per
 * spot), the photoreal mesh (when shown) has a tile under the rider, and the
 * rider's ground, mesh included, has then held still for START_STABLE_MS (the
 * avatar eases down onto it; a refining photoreal mesh moves it).
 */

/** Drawn globe within this of the most detailed terrain = refined. */
export const START_REFINED_M = 0.5;
/** The rider's ground must hold within this … */
export const START_STABLE_M = 0.3;
/** … for this long. */
export const START_STABLE_MS = 1_200;
/** A failed finest-height fetch is retried after this (World Terrain may not be assigned yet). */
export const START_FETCH_RETRY_MS = 1_000;

export class StartGroundWatch {
  private key: string | null = null;
  private target: number | null = null;
  private failedAt: number | null = null;
  private ele: number | null = null;
  private since = 0;
  /** True once the ground under the rider is refined and still. */
  ready = false;
  private lastDrawn: number | undefined;
  private lastGround = NaN;
  private lastNow = 0;

  /** Read-only state for render probes. */
  debug(): { target: number | null; drawnGlobe: number | undefined; ground: number; stableMs: number; ready: boolean } {
    return {
      target: this.target,
      drawnGlobe: this.lastDrawn,
      ground: this.lastGround,
      stableMs: this.ele === null ? 0 : this.lastNow - this.since,
      ready: this.ready,
    };
  }

  /** `mostDetailed(lon, lat)`: the finest terrain height there (undefined if unknown). */
  constructor(private readonly mostDetailed: (lon: number, lat: number) => Promise<number | undefined>) {}

  /**
   * One frame before the start. `drawnGlobe`: the globe's height under the
   * rider as drawn (undefined if no tile); `groundEle`: the rider's ground;
   * `meshPending`: the photoreal mesh shows but has no tile under the rider.
   */
  update(
    lon: number,
    lat: number,
    drawnGlobe: number | undefined,
    groundEle: number,
    nowMs: number,
    meshPending = false,
  ): void {
    this.lastDrawn = drawnGlobe;
    this.lastGround = groundEle;
    this.lastNow = nowMs;
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    const retry = this.failedAt !== null && nowMs - this.failedAt >= START_FETCH_RETRY_MS;
    if (key !== this.key || retry) {
      this.key = key;
      this.target = null;
      this.failedAt = null;
      const failed = () => {
        if (this.key === key) this.failedAt = nowMs;
      };
      this.mostDetailed(lon, lat).then((h) => {
        if (this.key !== key) return;
        if (h !== undefined && Number.isFinite(h)) this.target = h;
        else failed();
      }, failed);
    }
    const refined =
      !meshPending &&
      this.target !== null &&
      drawnGlobe !== undefined &&
      Math.abs(drawnGlobe - this.target) <= START_REFINED_M;
    if (!refined || this.ele === null || Math.abs(groundEle - this.ele) > START_STABLE_M) {
      this.ele = refined ? groundEle : null;
      this.since = nowMs;
    }
    this.ready = refined && nowMs - this.since >= START_STABLE_MS;
  }
}
