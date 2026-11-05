/**
 * One drawn ground on the photoreal renderer: is the globe drawn this frame?
 *
 * Cesium photoreal draws two grounds: the World Terrain globe (Bing imagery)
 * and the Google photoreal mesh, both opaque and depth-tested. Where the
 * coarse globe sits above the mesh, the globe is what you see, painted road
 * and all, and the real street is buried under it. On the steep Lugano shore
 * that is 5–26 m (measured against swissALTI3D: the mesh matches the real
 * road within ~1 m), so the rider rode a slab well above the street.
 *
 * Google's mesh covers the whole Earth and draws the far ground too, so once
 * it is the road under the rider the globe is hidden altogether: one ground,
 * near and far, and the rider rides the mesh. The globe comes back whenever
 * the mesh isn't the ground there: tileset hidden (camera over 5 km, mobile,
 * no token), no tile under the rider, or only a coarse tile floating far over
 * the ground (the Cuyahoga start: 610 m up for ~4 s; from below it is culled
 * and the rider would see sky under the road).
 *
 * Both switches wait a little (hysteresis), so a reading that drops out for a
 * frame or two while tiles refine doesn't flip the ground under the rider:
 * the globe can be metres above the mesh, so every flip moves the rider.
 * A rider that jumps (Ride again, a placed rider) gets the globe back at
 * once: the mesh where it lands may not have streamed yet.
 */

/** The mesh road has been under the rider this long before the globe hides (ms). */
export const GLOBE_HIDE_AFTER_MS = 750;
/** No mesh road under the rider for this long brings the globe back (ms). */
export const GLOBE_SHOW_AFTER_MS = 1_000;
/**
 * A rider this far from where it was the frame before has jumped (m): Ride
 * again puts it back on the start line, the probes place it. The mesh there
 * may not have streamed yet, so the globe comes back at once, as at a fresh
 * start, and hides again once the mesh is the road there.
 */
export const GLOBE_JUMP_M = 100;

export class GlobeGate {
  /** Whether the globe is drawn. */
  shown = true;
  private since: number | null = null;
  private lon = NaN;
  private lat = NaN;

  /**
   * One frame. `meshShown`: the photoreal tileset is part of the scene;
   * `meshGround`: its mesh is the road under the rider (avatar.meshGround);
   * `rider`: where the rider is this frame. Returns whether the globe draws
   * this frame.
   */
  update(nowMs: number, meshShown: boolean, meshGround: boolean, rider?: { lon: number; lat: number }): boolean {
    if (rider) {
      if (metresBetween(rider.lon, rider.lat, this.lon, this.lat) >= GLOBE_JUMP_M) this.reset();
      this.lon = rider.lon;
      this.lat = rider.lat;
    }
    if (!meshShown) {
      // Nothing else draws the ground: the globe, now.
      this.shown = true;
      this.since = null;
      return true;
    }
    const want = !meshGround;
    if (want === this.shown) {
      this.since = null;
      return this.shown;
    }
    this.since ??= nowMs;
    if (nowMs - this.since >= (want ? GLOBE_SHOW_AFTER_MS : GLOBE_HIDE_AFTER_MS)) {
      this.shown = want;
      this.since = null;
    }
    return this.shown;
  }

  /** Back to the globe (route change, no rider, a jump). */
  reset(): void {
    this.shown = true;
    this.since = null;
  }
}

/** Ground distance (m) between two spots a frame apart; 0 before the first. */
function metresBetween(lon: number, lat: number, fromLon: number, fromLat: number): number {
  if (Number.isNaN(fromLon)) return 0;
  return Math.hypot((lon - fromLon) * 111_320 * Math.cos((lat * Math.PI) / 180), (lat - fromLat) * 110_540);
}
