/**
 * The contract between the ride and whatever draws the world.
 *
 * The trainer side (FTMS, the ride loop, physics, FIT recording) produces one
 * RideFrame per rendered frame. A world layer consumes it and draws. The
 * Cesium play layer is the first implementation; a generated-world renderer
 * (for example a future Genie API) would implement the same interface. The
 * slope the trainer feels always comes from the GPX route, never from a layer.
 *
 * Keep this file free of Cesium and React imports.
 */

export interface RideFrame {
  /** Ride clock, ms since start (pauses excluded). */
  elapsedMs: number;
  /** Seconds since the previous frame. */
  dt: number;
  /** Rider's distance along the route, metres. */
  distanceM: number;
  /** Route length, metres. */
  routeLengthM: number;
  speedMs: number;
  powerW: number;
  cadenceRpm: number;
  gradePct: number;
}

export interface WorldLayer {
  readonly id: string;
  /** Called once per rendered frame while the layer is mounted. */
  update(frame: RideFrame): void;
  /** Remove everything the layer added. Safe to call twice. */
  dispose(): void;
}
