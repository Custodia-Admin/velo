/**
 * Is the ground under a waiting rider plausible yet?
 *
 * World Terrain refines in steps while a ride loads. A coarse tile's chord
 * sits tens to hundreds of metres off the real ground (948 m over a 329 m
 * Lugano shore, 211 m over the Trasimeno shore, measured), and a rider that
 * sets off on it drops onto the road seconds later. Nor does "the height
 * held still" prove anything: the route-elevation fallback holds still while
 * no tile exists at all.
 *
 * The test: both the globe the GPU draws under the rider and the rider's own
 * ground (mesh included) are within START_PLAUSIBLE_M of the most detailed
 * terrain the provider has there (sampleTerrainMostDetailed, fetched once per
 * spot), and the rider's ground has then held still for START_STABLE_MS.
 * It does not wait for the last metres of refinement or for the photoreal
 * tile under the rider: on the owner's laptop those take 15-25 s, and the
 * rider rides whatever is drawn anyway (the higher of mesh and globe, rising
 * at once: cesiumUtils.drawnGroundHeight, avatar.followGround), so a tile
 * that lands later moves the rider a few metres, never under the ground.
 * Once the globe is hidden (renderers/cesium/globeGate) the mesh road is the
 * one drawn ground, and World Terrain's finest height says nothing about it:
 * on the Lugano shore the street sits 7-26 m under it.
 */

/** Drawn globe and rider ground within this of the most detailed terrain = not a coarse chord. */
export const START_PLAUSIBLE_M = 15;
/** The rider's ground must hold within this … */
export const START_STABLE_M = 0.5;
/** … for this long. */
export const START_STABLE_MS = 500;
/** A failed finest-height fetch is retried after this (World Terrain may not be assigned yet). */
export const START_FETCH_RETRY_MS = 1_000;

export class StartGroundWatch {
  private key: string | null = null;
  private target: number | null = null;
  private failedAt: number | null = null;
  private ele: number | null = null;
  private since = 0;
  /** True once the ground under the rider is plausible and still. */
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
   * `meshGround`: the globe is hidden and the mesh under the rider is the one
   * drawn ground (renderers/cesium/globeGate), so the globe's refinement is
   * moot and only the rider's ground holding still counts.
   */
  update(
    lon: number,
    lat: number,
    drawnGlobe: number | undefined,
    groundEle: number,
    nowMs: number,
    meshGround = false,
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
    const target = this.target;
    const plausible =
      meshGround ||
      (target !== null &&
        drawnGlobe !== undefined &&
        Math.abs(drawnGlobe - target) <= START_PLAUSIBLE_M &&
        Math.abs(groundEle - target) <= START_PLAUSIBLE_M);
    if (!plausible || this.ele === null || Math.abs(groundEle - this.ele) > START_STABLE_M) {
      this.ele = plausible ? groundEle : null;
      this.since = nowMs;
    }
    this.ready = plausible && nowMs - this.since >= START_STABLE_MS;
  }
}
