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
 * A jump (Ride again) waits too: a globe drawn again at once shows coarse
 * tiles for a second, over the rider (5.7 m over the wheels at the
 * Lugano–Melide start, by the main view's depth).
 */
import type { GroundKind } from '@/lib/avatar';

/** The mesh road has been under the rider this long before the globe hides (ms). */
export const GLOBE_HIDE_AFTER_MS = 750;
/** No mesh road under the rider for this long brings the globe back (ms). */
export const GLOBE_SHOW_AFTER_MS = 1_000;

export class GlobeGate {
  /** Whether the globe is drawn. */
  shown = true;
  private since: number | null = null;

  /**
   * One frame. `meshShown`: the photoreal tileset is part of the scene;
   * `meshGround`: its mesh is the road under the rider (avatar.meshGround).
   * Returns whether the globe draws this frame.
   */
  update(nowMs: number, meshShown: boolean, meshGround: boolean): boolean {
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

  /** Back to the globe (route change, no rider). */
  reset(): void {
    this.shown = true;
    this.since = null;
  }
}

/** What the ride view draws this frame: the globe, and the painted road on it. */
export interface GroundDraw {
  globe: boolean;
  road: boolean;
}

/**
 * The globe and the painted road (asphalt corridor, dashed centre line, edge
 * stripes), from what the rider stands on (avatar.ground, lib/avatar
 * GroundKind):
 * - the globe is drawn whenever the mesh isn't the road under the rider
 *   ({@link GlobeGate});
 * - the painted road only where the globe IS the ground ('globe': no mesh
 *   road there at all), not where it is drawn to stand in for a ground the
 *   mesh doesn't draw under something over the road ('standIn'). The painted
 *   road is a ground classification: it paints whatever stands in its
 *   footprint, the globe and the mesh alike, so under tree crowns or a deck it
 *   ran up the trunks, the piers and the deck (Cuyahoga towpath under I-80).
 * The road's own wait is the same as the globe's, so it is never drawn
 * without the globe under it.
 */
export class GroundGate {
  private readonly globe = new GlobeGate();
  private readonly paint = new GlobeGate();

  /** One frame. `meshShown`: the photoreal tileset is part of the scene. */
  update(nowMs: number, meshShown: boolean, ground: GroundKind): GroundDraw {
    const globe = this.globe.update(nowMs, meshShown, ground === 'mesh');
    const road = this.paint.update(nowMs, meshShown, ground !== 'globe');
    return { globe, road: globe && road };
  }

  /** Back to the globe and its painted road (route change, no rider). */
  reset(): void {
    this.globe.reset();
    this.paint.reset();
  }
}
