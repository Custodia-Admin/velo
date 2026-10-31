/**
 * Velo's own world renderer ('world', the default): a token-free three.js
 * scene built from a baked world bundle (public/worlds/<id>/) — chunked
 * terrain, road ribbons, the route line, the stylized GLTF rider, ghosts and
 * pace bots, sky, sun and fog — driven by the same ride state as the HUD
 * (rideStore + lib/ride/rideSim.ridePose + handlebar lane steering).
 *
 * Lazy: only src/renderers/registry.ts imports this module, via import(), so
 * three.js downloads only when this renderer draws. Never imports Cesium.
 */

import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import * as THREE from 'three';

import { useRouteWeather } from '@/hooks/useLiveWeather';
import { stepLaneOffset } from '@/lib/laneOffset';
import { resolveSceneWeather, type SceneWeather } from '@/lib/meteo/sceneWeather';
import { ridePose } from '@/lib/ride/rideSim';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { chaseFraming } from '@/lib/world/cameraFraming';
import { worldForRoute, worldUrl, type WorldCatalogEntry } from '@/lib/world/catalog';
import { loadWorld, type LoadedWorld } from '@/lib/world/loadWorld';
import type { RiderPose, WorldRenderer, WorldViewProps } from '@/lib/world/renderer';
import { activeSteer } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Route } from '@/types';

import { ChaseCamera } from './ChaseCamera';
import { dampFactor } from './chaseRig';
import { Ghosts } from './Ghosts';
import { buildLandcoverCanvas } from './landcoverTexture';
import { renderDpr, threeQuality, type ThreeQuality } from './quality';
import { LiveRider, PaceBots, preloadRider } from './Rider';
import { angleDelta, estimatedCadence, leanAngle, placeRider } from './riderRig';
import { RouteLine, Roads } from './Roads';
import { Sky } from './Sky';
import { DEFAULT_MOOD } from './skyModel';
import { Terrain } from './Terrain';
import { createThreeWorldRenderer } from './threeWorldRenderer';
import { ChunkVisibility, createRideFrame, createSceneWorld, type RideFrame, type SceneWorld } from './worldScene';

preloadRider();

// One download + decode per world per session (a world is ~5 MB on the wire).
const worldCache = new Map<string, Promise<LoadedWorld>>();

export function loadCatalogWorld(entry: WorldCatalogEntry): Promise<LoadedWorld> {
  let p = worldCache.get(entry.id);
  if (!p) {
    p = loadWorld(worldUrl(entry));
    worldCache.set(entry.id, p);
    p.catch(() => worldCache.delete(entry.id));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Frame stats (for the perf readout and scripts via window.__veloRideDebug)
// ---------------------------------------------------------------------------

const FRAME_WINDOW = 240;

class FrameMeter {
  private buf = new Float64Array(FRAME_WINDOW);
  private n = 0;
  private i = 0;
  push(ms: number) {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this.buf[this.i] = ms;
    this.i = (this.i + 1) % FRAME_WINDOW;
    this.n = Math.min(FRAME_WINDOW, this.n + 1);
  }
  snapshot() {
    if (this.n === 0) return { fps: 0, avgMs: 0, p95Ms: 0, frames: 0 };
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    const sum = a.reduce((s, v) => s + v, 0);
    return {
      fps: Math.round((1000 * this.n) / sum),
      avgMs: Math.round((sum / this.n) * 10) / 10,
      p95Ms: Math.round(a[Math.min(this.n - 1, Math.floor(this.n * 0.95))] * 10) / 10,
      frames: this.n,
    };
  }
}

// ---------------------------------------------------------------------------
// In-canvas pieces
// ---------------------------------------------------------------------------

/** Computes the rider's frame (pose, ground placement, look-ahead, lean) before anything draws. */
function RideDriver({
  sceneWorld,
  frame,
  override,
}: {
  sceneWorld: SceneWorld;
  frame: RideFrame;
  override: { current: RiderPose | null };
}) {
  const memo = useMemo(() => ({ lane: 0, heading: NaN }), []);
  useFrame((state, delta) => {
    const dt = Math.min(0.1, Math.max(0, delta));
    const s = useRideStore.getState();
    const route = s.route;
    frame.dt = dt;
    frame.timeS = state.clock.elapsedTime;
    frame.rideState = s.rideState;
    if (!route || route.points.length < 2) {
      frame.valid = false;
      return;
    }
    memo.lane = stepLaneOffset(memo.lane, activeSteer(), dt);
    const pose =
      override.current ??
      ridePose(route, s.distance, { laneOffsetM: memo.lane, grade: s.grade, speed: s.speed });
    const placement = placeRider(sceneWorld, pose);
    const lookAhead = chaseFraming(useSettingsStore.getState().cameraDistance).lookAheadM;
    const aheadPose = ridePose(route, Math.min(route.totalDistance, pose.distance + lookAhead), {
      laneOffsetM: pose.laneOffsetM,
      offsetHeading: pose.heading,
    });
    const ahead = placeRider(sceneWorld, aheadPose).position;
    const speed = override.current ? pose.speed : s.speed;
    const yawRate = Number.isFinite(memo.heading) && dt > 0 ? angleDelta(pose.heading, memo.heading) / dt : 0;
    memo.heading = pose.heading;
    frame.lean += (leanAngle(speed, yawRate) - frame.lean) * dampFactor(0.35, dt);
    frame.pose = pose;
    frame.placement = placement;
    frame.ahead.x = ahead.x;
    frame.ahead.y = ahead.y;
    frame.ahead.z = ahead.z;
    frame.speed = speed;
    frame.cadence = s.cadence > 0 ? s.cadence : s.power > 0 ? estimatedCadence(speed) : 0;
    frame.valid = true;
  }, -1);
  return null;
}

function DprController({ quality }: { quality: ThreeQuality }) {
  const size = useThree((s) => s.size);
  const setDpr = useThree((s) => s.setDpr);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.far = quality.viewDistanceM * 1.05;
    cam.updateProjectionMatrix();
  }, [camera, quality.viewDistanceM]);
  useEffect(() => {
    const device = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    setDpr(renderDpr(quality, size.width, size.height, device));
  }, [quality, size.width, size.height, setDpr]);
  return null;
}

/** SMAA + soft bloom + vignette, 'high' tier only. Takes over rendering. */
function PostFx() {
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
  useFrame((_, delta) => composer.render(delta), 1);
  return null;
}

/** Fires once the rider model is in and two frames have been drawn. */
function ReadySignal({ onReady }: { onReady: () => void }) {
  const frames = useRef(0);
  const fired = useRef(false);
  useFrame(() => {
    if (fired.current) return;
    frames.current++;
    if (frames.current >= 2) {
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
}: {
  sceneWorld: SceneWorld;
  frame: RideFrame;
  meter: FrameMeter;
  visibility: ChunkVisibility;
  tier: string;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const info = useMemo(() => ({ calls: 0, triangles: 0 }), []);
  // Runs before this frame's render, so gl.info still holds the last frame's numbers.
  // (Any positive priority would switch off r3f's own render.)
  useFrame((_, delta) => {
    meter.push(delta * 1000);
    info.calls = gl.info.render.calls;
    info.triangles = gl.info.render.triangles;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __veloRideDebug?: () => object };
    const v = new THREE.Vector3();
    w.__veloRideDebug = () => {
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
        ...meter.snapshot(),
      };
    };
    return () => {
      delete w.__veloRideDebug;
    };
  }, [sceneWorld, frame, meter, visibility, camera, gl, size, tier, info]);
  return null;
}

function WorldScene({
  sceneWorld,
  route,
  quality,
  tier,
  mood,
  override,
  onReady,
}: {
  sceneWorld: SceneWorld;
  route: Route;
  quality: ThreeQuality;
  tier: string;
  mood: string;
  override: { current: RiderPose | null };
  onReady: () => void;
}) {
  const frame = useMemo(() => createRideFrame(), []);
  const meter = useMemo(() => new FrameMeter(), []);
  const visibility = useMemo(() => new ChunkVisibility(sceneWorld.chunks.length), [sceneWorld]);
  const landcover = useMemo(() => {
    const lc = buildLandcoverCanvas(sceneWorld.world, quality.landcoverTexels);
    if (!lc) return null;
    const tex = new THREE.CanvasTexture(lc.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  }, [sceneWorld, quality.landcoverTexels]);
  useEffect(() => () => landcover?.dispose(), [landcover]);
  const start = route.points[0];
  return (
    <>
      <DprController quality={quality} />
      <RideDriver sceneWorld={sceneWorld} frame={frame} override={override} />
      <Sky frame={frame} mood={mood} lat={start.lat} lon={start.lon} quality={quality} />
      <Terrain sceneWorld={sceneWorld} quality={quality} landcover={landcover} visibility={visibility} />
      <Roads sceneWorld={sceneWorld} visibility={visibility} quality={quality} />
      <RouteLine sceneWorld={sceneWorld} route={route} />
      <ChaseCamera frame={frame} heightfield={sceneWorld.heightfield} />
      <Ghosts sceneWorld={sceneWorld} route={route} />
      <Suspense fallback={null}>
        <LiveRider frame={frame} castShadow={quality.shadows} />
        <PaceBots sceneWorld={sceneWorld} />
        <ReadySignal onReady={onReady} />
      </Suspense>
      {quality.postFx && <PostFx />}
      <DebugHook sceneWorld={sceneWorld} frame={frame} meter={meter} visibility={visibility} tier={tier} />
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

/** The mood the route asks for: pinned override → live weather → route mood → world default. */
function useRouteMood(route: Route | null, world: LoadedWorld | null, override: string | null): string {
  const liveWeatherEnabled = useSettingsStore((s) => s.liveWeatherEnabled);
  const entry = useRouteWeather(route);
  const live = entry?.status === 'ready' ? entry.weather : null;
  return useMemo(() => {
    if (override) return override;
    const canned = (route ? scenicRouteById(route.id)?.mood : undefined) ?? world?.manifest.defaultMood ?? DEFAULT_MOOD;
    return resolveSceneWeather(canned as SceneWeather['mood'], live, liveWeatherEnabled).mood;
  }, [override, route, world, live, liveWeatherEnabled]);
}

export function ThreeWorldView({ onReady, onUnavailable }: WorldViewProps) {
  const route = useRideStore((s) => s.route);
  const entry = useMemo(() => worldForRoute(route), [route]);
  const tier = useSettingsStore((s) => s.graphicsQuality);
  const quality = threeQuality(tier);
  const [loaded, setLoaded] = useState<{ id: string; world: LoadedWorld } | null>(null);
  const [failed, setFailed] = useState(false);
  const override = useRef<RiderPose | null>(null);
  const [moodOverride, setMoodOverride] = useState<string | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

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
  const mood = useRouteMood(route, world, moodOverride);

  const renderer = useMemo<WorldRenderer>(
    () =>
      createThreeWorldRenderer({
        setRiderOverride: (pose) => {
          override.current = pose;
        },
        setMoodOverride,
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
    <div className="absolute inset-0 h-full w-full" data-world={entry?.id ?? ''} data-world-status={status}>
      {sceneWorld && route && !failed && (
        <WorldErrorBoundary
          onError={(e) => {
            setFailed(true);
            onUnavailableRef.current?.(`world renderer crashed: ${e instanceof Error ? e.message : String(e)}`);
          }}
        >
          <Canvas
            // MSAA and the shadow map type are fixed at context creation.
            key={`${quality.antialias}`}
            className="absolute inset-0"
            gl={{ antialias: quality.antialias, powerPreference: 'high-performance', alpha: false, stencil: false }}
            camera={{ fov: 60, near: 0.4, far: quality.viewDistanceM * 1.05, position: [0, 500, 0] }}
            shadows={quality.shadows}
            frameloop="always"
          >
            <WorldScene
              key={tier}
              sceneWorld={sceneWorld}
              route={route}
              quality={quality}
              tier={tier}
              mood={mood}
              override={override}
              onReady={handleReady}
            />
          </Canvas>
        </WorldErrorBoundary>
      )}
    </div>
  );
}
