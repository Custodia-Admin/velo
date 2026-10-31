/**
 * The renderer seam: what the ride view needs from whatever draws the world.
 *
 * Two renderers sit behind it. `'world'` is Velo's own token-free world
 * renderer (three.js, baked world bundles). `'photoreal'` is the Cesium globe
 * with the rider's own ion token (opt-in). Ride features talk to this
 * interface and to `lib/ride/rideSim`, never to a renderer directly, so a
 * renderer can be swapped without touching the HUD, FTMS or recording.
 *
 * Keep this file free of Cesium, three.js and React imports (lint rule +
 * src/test/architecture.test.ts).
 *
 * Mounting: a renderer is a view component (see `src/renderers/registry.ts`)
 * that RideView mounts with `WorldViewProps`. Once its first frame is up it
 * hands back a `WorldRenderer` through `onReady`; `dispose()` is the inverse
 * (React unmount calls it too).
 */

export type RendererKind = 'world' | 'photoreal';

export const RENDERER_KINDS: readonly RendererKind[] = ['world', 'photoreal'];

/** The token-free world renderer is the default for every rider. */
export const DEFAULT_RENDERER: RendererKind = 'world';

export function isRendererKind(value: unknown): value is RendererKind {
  return typeof value === 'string' && (RENDERER_KINDS as readonly string[]).includes(value);
}

/**
 * The renderer that actually draws, given the rider's preference and the
 * renderers this build ships. Falls back to the other renderer when the
 * preferred one is not available, so a ride never starts without a world.
 */
export function resolveRenderer(
  preferred: RendererKind,
  available: ReadonlySet<RendererKind>,
): RendererKind {
  if (available.has(preferred)) return preferred;
  const other = RENDERER_KINDS.find((k) => k !== preferred && available.has(k));
  return other ?? preferred;
}

/** Where the rider is and how they are moving, in route terms. */
export interface RiderPose {
  lat: number;
  lon: number;
  /** Route (GPX/DEM) elevation, metres. Renderers map it onto their own ground. */
  ele: number;
  /** Direction of travel, radians clockwise from north. */
  heading: number;
  /** Smoothed grade at the rider, percent. */
  grade: number;
  /** m/s. */
  speed: number;
  /** Distance along the route, metres. */
  distance: number;
  /** Sideways offset from the route line (handlebar steering), metres, + = right. */
  laneOffsetM: number;
}

/**
 * Camera modes every renderer understands. Mirrors `CameraMode` in
 * lib/cesiumCameras (settingsStore persists it) without importing Cesium code.
 */
export type WorldCameraMode =
  | 'chase'
  | 'firstPerson'
  | 'overhead'
  | 'sideTracking'
  | 'cinematic'
  | 'drone';

export const WORLD_CAMERA_MODES: readonly WorldCameraMode[] = [
  'chase',
  'firstPerson',
  'overhead',
  'sideTracking',
  'cinematic',
  'drone',
];

export interface WorldRenderer {
  readonly kind: RendererKind;
  /**
   * Engine handle for renderer-specific features (the Cesium Viewer for XR on
   * 'photoreal'). Undefined on renderers without one. Ride features must not
   * depend on it.
   */
  readonly native?: unknown;
  /**
   * Drive the rider from outside the ride loop (replays, previews). `null`
   * hands the rider back to the live ride (rideSim over the ride store).
   */
  setRider(pose: RiderPose | null): void;
  /** Switch camera mode (persists like the in-ride camera switcher). */
  setCamera(mode: WorldCameraMode): void;
  /**
   * Pin a scene mood (renderer-specific id, e.g. 'golden-hour'). `null`
   * returns to the route's own mood and live weather.
   */
  setMood(mood: string | null): void;
  /** Release everything the renderer holds. Safe to call more than once. */
  dispose(): void;
}

/** Props every renderer view component accepts. */
export interface WorldViewProps {
  /** Cesium ion token when the rider has one; renderers that need none ignore it. */
  ionToken: string | null;
  /** Called once the renderer has drawn its first frame. */
  onReady?: (renderer: WorldRenderer) => void;
  /**
   * The renderer cannot draw this ride after all (world bundle failed to
   * load, no WebGL2); the ride view falls back to another renderer.
   */
  onUnavailable?: (reason: string) => void;
}
