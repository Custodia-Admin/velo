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
 * spot), and the rider's ground, mesh included, has then held still for
 * HOLD_MS (the avatar eases down onto it; a refining photoreal mesh moves it).
 */

/** Drawn globe within this of the most detailed terrain = refined. */
export const START_REFINED_M = 0.5;
/** The rider's ground must hold within this … */
export const START_STABLE_M = 0.3;
/** … for this long. */
export const START_STABLE_MS = 1_200;

export class StartGroundWatch {
  private key: string | null = null;
  private target: number | null = null;
  private ele: number | null = null;
  private since = 0;
  /** True once the ground under the rider is refined and still. */
  ready = false;

  /** `mostDetailed(lon, lat)`: the finest terrain height there (undefined if unknown). */
  constructor(private readonly mostDetailed: (lon: number, lat: number) => Promise<number | undefined>) {}

  /**
   * One frame before the start. `drawnGlobe`: the globe's height under the
   * rider as drawn (undefined if no tile); `groundEle`: the rider's ground.
   */
  update(lon: number, lat: number, drawnGlobe: number | undefined, groundEle: number, nowMs: number): void {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (key !== this.key) {
      this.key = key;
      this.target = null;
      this.mostDetailed(lon, lat).then(
        (h) => {
          if (this.key === key) this.target = h !== undefined && Number.isFinite(h) ? h : null;
        },
        () => {},
      );
    }
    const refined =
      this.target !== null && drawnGlobe !== undefined && Math.abs(drawnGlobe - this.target) <= START_REFINED_M;
    if (!refined || this.ele === null || Math.abs(groundEle - this.ele) > START_STABLE_M) {
      this.ele = refined ? groundEle : null;
      this.since = nowMs;
    }
    this.ready = refined && nowMs - this.since >= START_STABLE_MS;
  }
}
