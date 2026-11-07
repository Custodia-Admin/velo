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
 *
 * Not where the globe stands in under tree crowns or a deck over the road the
 * rider holds, with its finest terrain known to be at or under that road
 * ('standIn', lib/avatar GroundKind): nothing is drawn under the rider until
 * the globe is, so the wait showed as a black void under the wheels at every
 * stand-in onset (Cuyahoga towpath 2–6 km at 30 km/h: 22 of them, about a
 * second each, a fifth to two fifths of the frame black). Drawn at once, it
 * buries nothing (the mesh draws over it), it lowers the rider by at most
 * GLOBE_STANDIN_UNDER_M, and it is no jump: in the cat-bed rides along those
 * 4 km it was never drawn over the wheels. Under something with no road held
 * (a jump, the start), with the finest terrain still on its way, or with it
 * over the road held, where it buries the street around it ('under'), it
 * waits as before.
 */
import type { GroundKind } from '@/lib/avatar';

/** The mesh road has been under the rider this long before the globe hides (ms). */
export const GLOBE_HIDE_AFTER_MS = 750;
/** No mesh road under the rider for this long brings the globe back (ms)… */
export const GLOBE_SHOW_AFTER_MS = 1_000;
/** …and this long where it stands in under something over the road held ('standIn', ms). */
export const GLOBE_STANDIN_SHOW_AFTER_MS = 0;

export class GlobeGate {
  /** Whether the globe is drawn. */
  shown = true;
  private since: number | null = null;
  /** When the first sample of the mesh run behind a pending hide was taken. */
  private sinceSample: number | null = null;

  /**
   * One frame. `meshShown`: the photoreal tileset is part of the scene;
   * `meshGround`: its mesh is the road under the rider (avatar.meshGround);
   * `showAfterMs`: how long without it brings the globe back; `sampledAtMs`:
   * when the ground sample this reading comes from was taken (same clock as
   * `nowMs`; by default every frame is a sample).
   * Returns whether the globe draws this frame.
   *
   * The hide waits for a sample: one taken {@link GLOBE_HIDE_AFTER_MS} or
   * more after the mesh run's first one, still on the mesh road. The ground
   * is sampled every 250 ms (lib/avatar GROUND_SAMPLE_INTERVAL_MS), each on
   * the first frame after that, so with frame jitter the samples drift later
   * than a timer on this frame clock. Timed on the frame clock alone, a run of
   * three mesh samples hid the globe a frame or three before the fourth
   * sample, and when that one said 'standIn' the globe was drawn again on the
   * next frame: 5–36 ms drop-outs at the crown edges, up to a quarter of the
   * frame black (Cuyahoga towpath 3.97 and 4.12 km). Confirmed by a sample, a
   * hide lasts at least until the next sample. It never comes sooner than the
   * frame-clock wait either, and at most one sample interval later.
   */
  update(
    nowMs: number,
    meshShown: boolean,
    meshGround: boolean,
    showAfterMs = GLOBE_SHOW_AFTER_MS,
    sampledAtMs = nowMs,
  ): boolean {
    if (!meshShown) {
      // Nothing else draws the ground: the globe, now.
      this.shown = true;
      this.since = null;
      this.sinceSample = null;
      return true;
    }
    const want = !meshGround;
    if (want === this.shown) {
      this.since = null;
      this.sinceSample = null;
      return this.shown;
    }
    this.since ??= nowMs;
    if (!want) this.sinceSample ??= sampledAtMs;
    const due = want
      ? nowMs - this.since >= showAfterMs
      : nowMs - this.since >= GLOBE_HIDE_AFTER_MS && sampledAtMs - (this.sinceSample as number) >= GLOBE_HIDE_AFTER_MS;
    if (due) {
      this.shown = want;
      this.since = null;
      this.sinceSample = null;
    }
    return this.shown;
  }

  /** Back to the globe (route change, no rider). */
  reset(): void {
    this.shown = true;
    this.since = null;
    this.sinceSample = null;
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
 *   ({@link GlobeGate}), at once where it stands in for the ground under
 *   something over the road held ('standIn': {@link GLOBE_STANDIN_SHOW_AFTER_MS});
 * - the painted road only where the globe IS the ground ('globe': no mesh
 *   road there at all), not where it is drawn to stand in for a ground the
 *   mesh doesn't draw under something over the road ('standIn', 'under'). The
 *   painted road is a ground classification: it paints whatever stands in its
 *   footprint, the globe and the mesh alike, so under tree crowns or a deck it
 *   ran up the trunks, the piers and the deck (Cuyahoga towpath under I-80).
 * The road waits at least as long as the globe, and is drawn only with it.
 */
export class GroundGate {
  private readonly globe = new GlobeGate();
  private readonly paint = new GlobeGate();

  /**
   * One frame. `meshShown`: the photoreal tileset is part of the scene;
   * `sampledAtMs`: when the sample behind `ground` was taken
   * (avatar.groundSampledAt): the globe hides only on a sample
   * ({@link GlobeGate.update}).
   */
  update(nowMs: number, meshShown: boolean, ground: GroundKind, sampledAtMs = nowMs): GroundDraw {
    const globe = this.globe.update(
      nowMs,
      meshShown,
      ground === 'mesh',
      ground === 'standIn' ? GLOBE_STANDIN_SHOW_AFTER_MS : GLOBE_SHOW_AFTER_MS,
      sampledAtMs,
    );
    const road = this.paint.update(nowMs, meshShown, ground !== 'globe');
    return { globe, road: globe && road };
  }

  /** Back to the globe and its painted road (route change, no rider). */
  reset(): void {
    this.globe.reset();
    this.paint.reset();
  }
}
