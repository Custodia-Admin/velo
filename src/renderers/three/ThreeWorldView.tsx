/**
 * Velo's own world renderer ('world', the default): a token-free three.js
 * scene built from a baked world bundle (public/worlds/<id>/) — chunked
 * terrain, road ribbons, the route line, the stylized GLTF rider, ghosts, the
 * couple ghost and pace bots, Play mode's postcards, sky, sun and fog — driven
 * by the same ride state as the HUD
 * (rideStore + lib/ride/rideSim.ridePose + handlebar lane steering).
 *
 * Lazy: only src/renderers/registry.ts imports this module, via import(), so
 * three.js downloads only when this renderer draws. Never imports Cesium.
 */

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import * as THREE from 'three';

import { useRouteWeather } from '@/hooks/useLiveWeather';
import type { WeatherCondition } from '@/lib/meteo/weatherCondition';
import { EMPTY_TILES, FrameStats } from '@/lib/perf/frameStats';
import { exposeScenePerf, IDLE_GAP_MS, PUBLISH_MS, publishScenePerf, type ScenePerf } from '@/lib/perf/scenePerf';
import { heldRiderPose } from '@/lib/ride/rideSim';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { chaseFraming, RIDE_FOV_Y_DEG } from '@/lib/world/cameraFraming';
import { worldForRoute, worldUrl, type WorldCatalogEntry } from '@/lib/world/catalog';
import { loadWorld, type LoadedWorld } from '@/lib/world/loadWorld';
import { openWorldCache } from '@/lib/world/worldCache';
import { TIME_PRESETS, type TimePreset, type WorldLightInput } from '@/lib/world/moods';
import type { RiderPose, WorldRenderer, WorldViewProps } from '@/lib/world/renderer';
import { activeSteer } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { canvasKeyFor, useWorldViewStore } from '@/stores/worldViewStore';
import type { Route } from '@/types';

import { Bridges } from './Bridges';
import { Buildings, StreetLights } from './Buildings';
import { fillContainer } from './canvasSize';
import { ChaseCamera } from './ChaseCamera';
import { ContextLossWatch } from './contextLoss';
import { CoupleGhost } from './CoupleGhost';
import { sceneLandmarks } from './directorCamera';
import { createClockMemo, keepClockSteady } from './frameClock';
import { fenceGL, FrameGate } from './frameGate';
import { Ghosts } from './Ghosts';
import { Landmarks } from './Landmarks';
import { buildLandcoverCanvas } from './landcoverTexture';
import { createAtmosphere } from './materials/atmosphere';
import { createPostcardPins, PlayLayer } from './PlayLayer';
import { renderDpr, threeQuality, type ThreeQuality } from './quality';
import { LiveRider, PaceBots, preloadRider } from './Rider';
import { createRideDriverMemo, driveRideFrame } from './rideDriver';
import { worldRideLine } from './rideLineRoads';
import { RouteLine, Roads } from './Roads';
import { createLightState, Sky, type LightState } from './Sky';
import { DEFAULT_MOOD } from './skyModel';
import { SunOcclusion } from './sunOcclusion';
import { Terrain } from './Terrain';
import { createThreeWorldRenderer } from './threeWorldRenderer';
import { Vegetation } from './Vegetation';
import { Water } from './Water';
import { Weather } from './Weather';
import { ChunkVisibility, createRideFrame, createSceneWorld, drawnGround, routeSurface, type RideFrame, type SceneWorld } from './worldScene';

preloadRider();

// One download + decode per world per session (a world is ~5 MB on the wire).
// A remote world's files also go to the Cache API, so the next session
// (offline included) reads them from disk (lib/world/worldCache).
const worldCache = new Map<string, Promise<LoadedWorld>>();

export function loadCatalogWorld(entry: WorldCatalogEntry): Promise<LoadedWorld> {
  let p = worldCache.get(entry.id);
  if (!p) {
    p = (entry.remote ? openWorldCache() : Promise.resolve(null)).then((cache) => loadWorld(worldUrl(entry), { cache }));
    worldCache.set(entry.id, p);
    p.catch(() => worldCache.delete(entry.id));
  }
  return p;
}

// ---------------------------------------------------------------------------
// In-canvas pieces
// ---------------------------------------------------------------------------

/** Computes the rider's frame (pose, ground placement, look-ahead, lean) before anything draws. Exported for tests. */
export function RideDriver({
  sceneWorld,
  frame,
  override,
  ground,
}: {
  sceneWorld: SceneWorld;
  frame: RideFrame;
  override: { current: RiderPose | null };
  ground: (x: number, y: number) => number;
}) {
  const memo = useMemo(() => createRideDriverMemo(), []);
  useFrame((state, delta) => {
    const s = useRideStore.getState();
    driveRideFrame(frame, memo, sceneWorld, {
      route: s.route,
      distance: s.distance,
      speed: s.speed,
      grade: s.grade,
      cadence: s.cadence,
      power: s.power,
      rideState: s.rideState,
      steer: activeSteer(),
      override: override.current,
      lookAheadM: chaseFraming(useSettingsStore.getState().cameraDistance).lookAheadM,
      dt: Math.min(0.1, Math.max(0, delta)),
      timeS: state.clock.elapsedTime,
      ground,
    });
  }, -1);
  return null;
}

/**
 * Keeps the camera's far plane on the tier's view distance and reports the
 * pixel ratio for this canvas size. The ratio goes back up to <Canvas dpr>:
 * r3f re-applies that prop on every render, so a store-side setDpr() would
 * be undone.
 */
function DprController({ quality, onDpr }: { quality: ThreeQuality; onDpr: (dpr: number) => void }) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.far = quality.viewDistanceM * 1.05;
    cam.updateProjectionMatrix();
  }, [camera, quality.viewDistanceM]);
  useEffect(() => {
    const device = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    onDpr(renderDpr(quality, size.width, size.height, device));
  }, [quality, size.width, size.height, onDpr]);
  return null;
}

/**
 * Draws each frame through the frame gate (frameGate.ts). r3f's own render is
 * off (a priority-1 useFrame), so this is the one place a frame is drawn: the
 * plain scene render or PostFx's composer. A frame the GPU has no room for is
 * held back; the scene parts still updated, and the next frame drawn shows the
 * latest state. The meter gets the time between DRAWN frames, so ?perf=1 and
 * __veloPerf report the frames on screen.
 */
function useGatedDraw(gate: FrameGate, meter: FrameStats, draw: (state: RootState, delta: number) => void) {
  const gl = useThree((s) => s.gl);
  const sinceDrawnMs = useRef(0);
  useEffect(() => () => gate.dispose(), [gate, gl]);
  useFrame((state, delta) => {
    const ms = delta * 1000;
    // A stalled loop (a hidden tab) is not frame time.
    sinceDrawnMs.current = ms < IDLE_GAP_MS ? sinceDrawnMs.current + ms : 0;
    if (gate.submit(fenceGL(gl.getContext()), performance.now(), () => draw(state, sinceDrawnMs.current / 1000))) {
      meter.push(sinceDrawnMs.current);
      sinceDrawnMs.current = 0;
    }
  }, 1);
}

/** The plain render (no post-processing), through the frame gate. Exported for tests. */
export function SceneDraw({ gate, meter }: { gate: FrameGate; meter: FrameStats }) {
  useGatedDraw(gate, meter, (state) => state.gl.render(state.scene, state.camera));
  return null;
}

/** SMAA + soft bloom + vignette, 'high' tier only. Draws through the frame gate in place of SceneDraw. Exported for tests. */
export function PostFx({ gate, meter }: { gate: FrameGate; meter: FrameStats }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const composer = useMemo(() => {
    const c = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType });
    c.addPass(new RenderPass(scene, camera));
    c.addPass(
      new EffectPass(
        camera,
        new BloomEffect({ intensity: 0.35, luminanceThreshold: 0.85, mipmapBlur: true }),
        new VignetteEffect({ darkness: 0.32, offset: 0.35 }),
        new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
        new SMAAEffect(),
      ),
    );
    return c;
  }, [gl, scene, camera]);
  useEffect(() => {
    const prev = gl.toneMapping;
    gl.toneMapping = THREE.NoToneMapping;
    return () => {
      gl.toneMapping = prev;
      composer.dispose();
    };
  }, [gl, composer]);
  useEffect(() => composer.setSize(size.width, size.height), [composer, size.width, size.height]);
  useGatedDraw(gate, meter, (_, delta) => composer.render(delta));
  return null;
}

/**
 * Keeps the canvas clock running on from the last frame after r3f restarts it
 * at 0 (the frame loop paused behind the finish screen; see frameClock.ts).
 * Priority -2: before the ride driver (-1) and everything else reads it.
 * Exported for tests.
 */
export function SteadyClock() {
  const memo = useMemo(() => createClockMemo(), []);
  useFrame((state, delta) => keepClockSteady(state.clock, memo, delta), -2);
  return null;
}

/** Fires once the rider model is in and two frames have been drawn since (frames the gate held back don't count). Exported for tests. */
export function ReadySignal({ onReady, gate }: { onReady: () => void; gate: FrameGate }) {
  const drawnAtMount = useRef<number | null>(null);
  const fired = useRef(false);
  useFrame(() => {
    if (fired.current) return;
    drawnAtMount.current ??= gate.drawn;
    if (gate.drawn - drawnAtMount.current >= 2) {
      fired.current = true;
      onReady();
    }
  });
  return null;
}

function DebugHook({
  sceneWorld,
  frame,
  meter,
  visibility,
  tier,
  lightState,
  stats,
  gate,
}: {
  sceneWorld: SceneWorld;
  frame: RideFrame;
  meter: FrameStats;
  visibility: ChunkVisibility;
  tier: string;
  lightState: LightState;
  stats: { trees: number };
  gate: FrameGate;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const scene = useThree((s) => s.scene);
  const info = useMemo(() => ({ calls: 0, triangles: 0, lastPublish: 0 }), []);
  useEffect(() => {
    // Scene handle for perf/visual probes: dev builds, or `localStorage['velo.debug.three'] = '1'`.
    let opted = false;
    try {
      opted = window.localStorage.getItem('velo.debug.three') === '1';
    } catch {
      opted = false;
    }
    if (!import.meta.env.DEV && !opted) return;
    const w = window as unknown as { __veloThree?: unknown };
    const handle = { scene, camera, gl };
    w.__veloThree = handle;
    return () => {
      // A remounted canvas (context loss) may have set its own handle already.
      if (w.__veloThree === handle) delete w.__veloThree;
    };
  }, [scene, camera, gl]);
  const perfSnapshot = useCallback((): ScenePerf => {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return {
      ...meter.snapshot(),
      tiles: EMPTY_TILES,
      canvas: [gl.domElement.width, gl.domElement.height],
      resolutionScale: gl.getPixelRatio() / dpr,
      dpr,
      msaa: gl.getContextAttributes()?.antialias ? 4 : 1,
      requestRenderMode: false,
    };
  }, [gl, meter]);
  // Runs before this frame's draw (useGatedDraw, priority 1), so gl.info still
  // holds the last drawn frame's numbers. useGatedDraw feeds the meter.
  useFrame((state) => {
    info.calls = gl.info.render.calls;
    info.triangles = gl.info.render.triangles;
    const t = state.clock.elapsedTime * 1000;
    if (t - info.lastPublish >= PUBLISH_MS) {
      info.lastPublish = t;
      publishScenePerf(perfSnapshot());
    }
  });
  // The ?perf=1 overlay and window.__veloPerf read the same numbers as the Cesium view.
  useEffect(() => {
    exposeScenePerf(perfSnapshot);
    return () => {
      const w = window as unknown as { __veloPerf?: unknown };
      if (w.__veloPerf === perfSnapshot) exposeScenePerf(null);
    };
  }, [perfSnapshot]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __veloRideDebug?: () => object };
    const v = new THREE.Vector3();
    const debug = () => {
      const p = frame.placement;
      const hf = sceneWorld.heightfield;
      let riderScreen: [number, number] | null = null;
      if (p) {
        v.set(p.position.x, p.position.y + 1, p.position.z).project(camera);
        if (v.z < 1) riderScreen = [Math.round(((v.x + 1) / 2) * size.width), Math.round(((1 - v.y) / 2) * size.height)];
      }
      return {
        renderer: 'world',
        world: sceneWorld.world.manifest.id,
        quality: tier,
        dpr: gl.getPixelRatio(),
        canvas: [size.width, size.height],
        distance: frame.pose?.distance ?? null,
        riderXZ: p ? [Math.round(p.position.x * 100) / 100, Math.round(p.position.z * 100) / 100] : null,
        routeEle: frame.pose?.ele ?? null,
        groundEle: p ? p.position.y : null,
        riderGroundGap: p ? p.position.y - hf.sampleHeight(p.worldX, p.worldY) : null,
        cameraHeight: camera.position.y,
        cameraClearance: camera.position.y - hf.sampleHeight(camera.position.x, -camera.position.z),
        riderScreen,
        nearChunks: visibility.count(),
        drawCalls: info.calls,
        triangles: info.triangles,
        // Frames drawn / held back while the GPU was behind, and its measured time per frame (frameGate.ts).
        frameGate: {
          drawn: gate.drawn,
          held: gate.held,
          inFlight: gate.inFlight,
          gpuFrameMs: gate.gpuFrameMs === null ? null : Math.round(gate.gpuFrameMs),
        },
        trees: stats.trees,
        light: lightState.current
          ? {
              phase: lightState.current.phase,
              at: lightState.current.at.toISOString(),
              timeSource: lightState.current.timeSource,
              sunAltitude: Math.round(lightState.current.sun.altitudeDeg * 10) / 10,
              condition: lightState.current.weather.condition,
              weatherSource: lightState.current.weather.source,
              rain: lightState.current.weather.rain,
            }
          : null,
        ...meter.snapshot(),
      };
    };
    w.__veloRideDebug = debug;
    return () => {
      if (w.__veloRideDebug === debug) delete w.__veloRideDebug;
    };
  }, [sceneWorld, frame, meter, visibility, camera, gl, size, tier, info, lightState, stats, gate]);
  return null;
}

/** Everything inside the canvas for one world. Exported for tests: what the scene hands its parts (landmarks, the ground, the start hold). */
export function WorldScene({
  sceneWorld,
  route,
  quality,
  tier,
  lightInput,
  override,
  groundReady,
  onReady,
  onDpr,
}: {
  sceneWorld: SceneWorld;
  route: Route;
  quality: ThreeQuality;
  tier: string;
  lightInput: Omit<WorldLightInput, 'date'>;
  override: { current: RiderPose | null };
  groundReady: { current: () => boolean };
  onReady: () => void;
  onDpr: (dpr: number) => void;
}) {
  const frame = useMemo(() => createRideFrame(), []);
  const meter = useMemo(() => new FrameStats(), []);
  // One per canvas: every frame draws through it (useGatedDraw).
  const gate = useMemo(() => new FrameGate(), []);
  const visibility = useMemo(() => new ChunkVisibility(sceneWorld.chunks.length), [sceneWorld]);
  // One height source: the terrain triangles as drawn, for rider, camera,
  // bots, ghosts, roads and the route line; on the bridge decks this route
  // rides, the deck (under any other deck it stays the ground).
  const ground = useMemo(
    () => routeSurface(sceneWorld, route.id, drawnGround(sceneWorld, visibility, { near: quality.nearStep, far: quality.farStep })),
    [sceneWorld, route.id, visibility, quality.nearStep, quality.farStep],
  );
  // The ride start holds until the chunk under the rider draws full detail.
  useEffect(() => {
    const ready = () => {
      const p = frame.placement;
      if (!frame.valid || !p) return false;
      const i = sceneWorld.locate(p.worldX, p.worldY);
      return i < 0 || visibility.near[i] === 1;
    };
    groundReady.current = ready;
    return () => {
      // A remounted canvas (context loss) may have installed its own check already.
      if (groundReady.current === ready) groundReady.current = () => true;
    };
  }, [groundReady, frame, sceneWorld, visibility]);
  const atmo = useMemo(() => createAtmosphere(), []);
  const lightState = useMemo(() => createLightState(), []);
  const stats = useMemo(() => ({ trees: 0 }), []);
  const occlusion = useMemo(
    () => (quality.occlusionScale > 0 ? new SunOcclusion(sceneWorld.heightfield, { scale: quality.occlusionScale }) : null),
    [sceneWorld, quality.occlusionScale],
  );
  useEffect(() => () => occlusion?.dispose(), [occlusion]);
  const maps = useMemo(() => {
    const lc = buildLandcoverCanvas(sceneWorld.world, quality.landcoverTexels);
    if (!lc) return null;
    const tex = new THREE.CanvasTexture(lc.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    let aux: THREE.Texture | null = null;
    if (lc.aux) {
      const t = new THREE.CanvasTexture(lc.aux);
      t.colorSpace = THREE.NoColorSpace;
      t.flipY = false;
      t.generateMipmaps = false;
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      aux = t;
    }
    return { landcover: tex, aux };
  }, [sceneWorld, quality.landcoverTexels]);
  useEffect(
    () => () => {
      maps?.landcover.dispose();
      maps?.aux?.dispose();
    },
    [maps],
  );
  // Named places the route passes (manifest POIs), for the show director's landmark orbits.
  const directorLandmarks = useMemo(() => sceneLandmarks(route, sceneWorld), [route, sceneWorld]);
  // Build the line the riders are drawn on with the scene (tens of ms on a long route), not in the
  // first ride frame, kept on the roads this world paints (rideLineRoads).
  useMemo(() => worldRideLine(route, sceneWorld), [route, sceneWorld]);
  // Play mode: which of those places are postcards still to collect (PlayLayer writes, Landmarks reads).
  const postcardPins = useMemo(() => createPostcardPins(), []);
  return (
    <>
      <DprController quality={quality} onDpr={onDpr} />
      <RideDriver sceneWorld={sceneWorld} frame={frame} override={override} ground={ground} />
      <Sky frame={frame} lightInput={lightInput} quality={quality} atmo={atmo} occlusion={occlusion} lightState={lightState} />
      <Terrain sceneWorld={sceneWorld} quality={quality} landcover={maps?.landcover ?? null} aux={maps?.aux ?? null} atmo={atmo} visibility={visibility} />
      <Water sceneWorld={sceneWorld} atmo={atmo} />
      <Roads sceneWorld={sceneWorld} visibility={visibility} quality={quality} atmo={atmo} />
      <Bridges sceneWorld={sceneWorld} visibility={visibility} quality={quality} atmo={atmo} />
      <RouteLine sceneWorld={sceneWorld} route={route} visibility={visibility} quality={quality} atmo={atmo} />
      <Buildings sceneWorld={sceneWorld} quality={quality} atmo={atmo} />
      <StreetLights sceneWorld={sceneWorld} atmo={atmo} />
      <Vegetation sceneWorld={sceneWorld} quality={quality} atmo={atmo} stats={stats} />
      <Weather quality={quality} atmo={atmo} lightState={lightState} />
      <Landmarks sceneWorld={sceneWorld} quality={quality} postcards={postcardPins} />
      <PlayLayer sceneWorld={sceneWorld} route={route} pins={postcardPins} />
      <ChaseCamera frame={frame} heightfield={sceneWorld.heightfield} landmarks={directorLandmarks} ground={ground} />
      <Ghosts sceneWorld={sceneWorld} route={route} ground={ground} />
      <Suspense fallback={null}>
        <LiveRider frame={frame} castShadow={quality.shadows} />
        <PaceBots sceneWorld={sceneWorld} route={route} ground={ground} frame={frame} />
        <CoupleGhost sceneWorld={sceneWorld} route={route} ground={ground} frame={frame} />
        <ReadySignal onReady={onReady} gate={gate} />
      </Suspense>
      {quality.postFx ? <PostFx gate={gate} meter={meter} /> : <SceneDraw gate={gate} meter={meter} />}
      <DebugHook sceneWorld={sceneWorld} frame={frame} meter={meter} visibility={visibility} tier={tier} lightState={lightState} stats={stats} gate={gate} />
    </>
  );
}

class WorldErrorBoundary extends Component<{ onError: (e: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * What the world's light is computed from (all but the clock): the route's
 * own mood (or a pinned one), the live reading and the rider's live-weather
 * setting, plus any preview pins (time of day / weather).
 */
function useLightInput(
  route: Route | null,
  world: LoadedWorld | null,
  moodOverride: string | null,
  pins: { time: TimePreset | null; weather: WeatherCondition | null },
): Omit<WorldLightInput, 'date'> {
  const liveWeatherEnabled = useSettingsStore((s) => s.liveWeatherEnabled);
  const entry = useRouteWeather(route);
  const live = entry?.status === 'ready' ? entry.weather : null;
  return useMemo(() => {
    const start = route?.points[0];
    const canned = (route ? scenicRouteById(route.id)?.mood : undefined) ?? world?.manifest.defaultMood ?? DEFAULT_MOOD;
    return {
      lat: start?.lat ?? world?.manifest.origin.lat ?? 0,
      lon: start?.lon ?? world?.manifest.origin.lon ?? 0,
      mood: moodOverride ?? canned,
      // A pinned mood is a look on its own: live weather doesn't override it.
      live: moodOverride ? null : live,
      liveEnabled: moodOverride ? false : liveWeatherEnabled,
      time: pins.time,
      weather: pins.weather,
      groundMinM: world?.manifest.heightfield.minHeight,
    };
  }, [route, world, moodOverride, live, liveWeatherEnabled, pins.time, pins.weather]);
}

const PIN_WEATHER: readonly WeatherCondition[] = ['clear', 'partly-cloudy', 'overcast', 'fog', 'drizzle', 'rain', 'snow', 'storm'];

export function ThreeWorldView({ onReady, onUnavailable, covered = false }: WorldViewProps) {
  const route = useRideStore((s) => s.route);
  const entry = useMemo(() => worldForRoute(route), [route]);
  const tier = useSettingsStore((s) => s.graphicsQuality);
  const quality = threeQuality(tier);
  const [loaded, setLoaded] = useState<{ id: string; world: LoadedWorld } | null>(null);
  const [dpr, setDpr] = useState(() =>
    typeof window === 'undefined'
      ? 1
      : renderDpr(quality, window.innerWidth, window.innerHeight, window.devicePixelRatio || 1),
  );
  const [failed, setFailed] = useState(false);
  const override = useRef<RiderPose | null>(null);
  const groundReady = useRef<() => boolean>(() => true);
  const [moodOverride, setMoodOverride] = useState<string | null>(null);
  const [pins, setPins] = useState<{ time: TimePreset | null; weather: WeatherCondition | null }>({ time: null, weather: null });
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  // WebGL context loss (stores/worldViewStore): this view owns the one slot
  // while mounted. A lost context shows in the ride's status chip; a restore
  // or the rider's tap bumps the canvas key, which remounts <Canvas> on a
  // fresh context. The world bundle, the ride and its recording carry on.
  const [viewId, setViewId] = useState(0);
  useEffect(() => {
    const id = useWorldViewStore.getState().attach();
    setViewId(id);
    return () => useWorldViewStore.getState().detach(id);
  }, []);
  const canvasKey = useWorldViewStore((s) => canvasKeyFor(s, viewId));
  // A lost canvas is hidden until it remounts: Chrome paints a dead WebGL
  // canvas white with a broken-image glyph; the plain ride background is calmer.
  const contextLost = useWorldViewStore((s) => s.view !== null && s.view.id === viewId && s.view.stopped);

  useEffect(() => {
    if (!entry) {
      if (route) onUnavailableRef.current?.('no world bundle covers this route');
      return;
    }
    let cancelled = false;
    loadCatalogWorld(entry).then(
      (world) => {
        if (!cancelled) setLoaded({ id: entry.id, world });
      },
      (err: unknown) => {
        if (cancelled) return;
        setFailed(true);
        onUnavailableRef.current?.(`world ${entry.id} failed to load: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entry, route]);

  const world = loaded && entry && loaded.id === entry.id ? loaded.world : null;
  const sceneWorld = useMemo(() => (world ? createSceneWorld(world) : null), [world]);
  const lightInput = useLightInput(route, world, moodOverride, pins);

  // Preview / reference-shot hook: pin the time of day and the weather, or
  // hold the rider at a distance along the route (null releases it).
  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as {
      __veloWorldLight?: {
        set: (p: { time?: string | null; weather?: string | null }) => void;
        place: (distanceM: number | null) => void;
      };
    };
    w.__veloWorldLight = {
      place: (distanceM) => {
        const r = routeRef.current;
        if (distanceM === null || !r) {
          override.current = null;
          return;
        }
        override.current = heldRiderPose(r, distanceM);
      },
      set: (p) =>
        setPins((cur) => ({
          time: p.time === undefined ? cur.time : TIME_PRESETS.includes(p.time as TimePreset) ? (p.time as TimePreset) : null,
          weather: p.weather === undefined ? cur.weather : PIN_WEATHER.includes(p.weather as WeatherCondition) ? (p.weather as WeatherCondition) : null,
        })),
    };
    return () => {
      delete w.__veloWorldLight;
    };
  }, []);

  const renderer = useMemo<WorldRenderer>(
    () =>
      createThreeWorldRenderer({
        setRiderOverride: (pose) => {
          override.current = pose;
        },
        setMoodOverride,
        groundReady: () => groundReady.current(),
      }),
    [],
  );
  const readyFired = useRef(false);
  const handleReady = useMemo(
    () => () => {
      if (readyFired.current) return;
      readyFired.current = true;
      onReadyRef.current?.(renderer);
    },
    [renderer],
  );
  useEffect(() => () => renderer.dispose(), [renderer]);

  const status = failed ? 'error' : sceneWorld ? 'ready' : 'loading';
  return (
    <div
      className="absolute inset-0 h-full w-full"
      data-world={entry?.id ?? ''}
      data-world-status={status}
      data-world-context={contextLost ? 'lost' : 'live'}
    >
      {sceneWorld && route && !failed && (
        <WorldErrorBoundary
          onError={(e) => {
            setFailed(true);
            onUnavailableRef.current?.(`world renderer crashed: ${e instanceof Error ? e.message : String(e)}`);
          }}
        >
          <Canvas
            // MSAA and the shadow map type are fixed at context creation;
            // a new canvasKey rebuilds the scene after a lost context.
            key={`${quality.antialias}:${canvasKey}`}
            className={contextLost ? 'absolute inset-0 invisible' : 'absolute inset-0'}
            gl={{ antialias: quality.antialias, powerPreference: 'high-performance', alpha: false, stencil: false }}
            camera={{ fov: RIDE_FOV_Y_DEG, near: 0.4, far: quality.viewDistanceM * 1.05, position: [0, 500, 0] }}
            shadows={quality.shadows}
            dpr={dpr}
            // Covered by the finish screen: no frames (r3f's loop stops; the
            // scene and the WebGL context stay), drawing again for Ride again.
            frameloop={covered ? 'never' : 'always'}
            // In the floating ride window r3f leaves the canvas's CSS size at its buffer size (canvasSize.ts).
            onCreated={({ gl }) => fillContainer(gl.domElement)}
          >
            <ContextLossWatch viewId={viewId} canvasKey={canvasKey} />
            <SteadyClock />
            <WorldScene
              key={tier}
              sceneWorld={sceneWorld}
              route={route}
              quality={quality}
              tier={tier}
              lightInput={lightInput}
              override={override}
              groundReady={groundReady}
              onReady={handleReady}
              onDpr={setDpr}
            />
          </Canvas>
        </WorldErrorBoundary>
      )}
    </div>
  );
}
