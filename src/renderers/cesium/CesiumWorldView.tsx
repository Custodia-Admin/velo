import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { sanitizeForLabel } from '@/lib/security/sanitize';

import { useRideStore } from '@/stores/rideStore';
import { useThemeStore } from '@/stores/themeStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShowStore } from '@/stores/showStore';
import { effectiveCameraMode } from '@/lib/show/showDirector';
import { useGhostStore } from '@/stores/ghostStore';
import { useRouteWeather } from '@/hooks/useLiveWeather';
import {
  cannedScene,
  resolveSceneWeather,
  sceneKey,
  type SceneWeather,
} from '@/lib/meteo/sceneWeather';
import type { Route } from '@/types';
import { usePlayLayer } from '@/hooks/usePlayLayer';
import {
  applyFollowCam,
  applySceneMood,
  clampCartesiansToScene,
  clearMeshTopReads,
  flyToPoint,
  flyToRoute,
  getPhotorealTileset,
  getTerrainProvider,
  hasIonToken,
  julianDateForMood,
  liftAboveTerrain,
  meshTopReadStats,
  MOODS,
  moodForRoute,
  resetFollowCam,
  seedFollowCam,
  routeToCartesians,
  onSceneSurface,
  sceneEle,
  setIonToken,
  setupBaseImagery,
  type MoodId,
} from '@/lib/cesiumUtils';
import { ICONIC_ROUTES } from '@/lib/iconicRoutes';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { WORLD_TOUR_STAGES } from '@/lib/worldTourStages';
import {
  buildGradientPolylines,
  buildRouteMarkers,
  removeGradientPolylines,
  removeRouteMarkers,
  type GradientSegment,
  type RouteMarkers,
} from '@/lib/routeVisuals';
import { createAvatar, createGroundSampler, type Avatar } from '@/lib/avatar';
import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { ridePose } from '@/lib/ride/rideSim';
import type { RiderPose, WorldViewProps } from '@/lib/world/renderer';
import { createCesiumWorldRenderer } from '@/renderers/cesium/cesiumWorldRenderer';
import { GlobeGate } from '@/renderers/cesium/globeGate';
import { StartGroundWatch } from '@/renderers/cesium/startGround';
import { createSideCamSight } from '@/lib/sideCamSight';
import { placeSideCam } from '@/renderers/cesium/sideCam';
import { applyHudLensCrop, lensCropState, type LensCropState } from '@/renderers/cesium/hudLensCrop';
import {
  applyGraphicsQuality,
  recommendedGraphicsQuality,
  resolutionScaleFor,
  webglRenderer,
} from '@/lib/graphicsQuality';
import { applyCinematicEffects, destroyCinematicEffects } from '@/lib/cinematicEffects';
import { loadGhosts, type GhostRide } from '@/lib/ghosts';
import { shouldChaseCamUpdate } from '@/lib/chaseCamGuard';
import { createLaneState, stepLane } from '@/lib/controllers/steerFeel';
import { activeSteer } from '@/stores/controllerStore';
import type { AvatarColors } from '@/lib/avatarConfig';
import { placeBotAvatars, updateBotAvatars } from './botAvatars';
import {
  createWeatherSystem,
  type WeatherSystem,
} from '@/lib/weatherParticles';
import {
  configureSky,
  spawnCumulusClouds,
  updateCloudParallax,
  sunAzimuthAndAltitude,
  scaledCloudCount,
} from '@/lib/skyAndClouds';
import {
  createShadowEntity,
  updateShadowEntity,
  type ShadowHandle,
} from '@/lib/dynamicShadow';
import {
  createWetRoadSurfaceProperty,
} from '@/lib/wetRoadMaterial';
import {
  spectatorZonesForRoute,
  generateSpectatorPositions,
  createSpectatorBillboards,
  updateSpectatorVisibility,
  buildSpectatorDistanceIndex,
  type SpectatorCollection,
} from '@/lib/spectatorSystem';
import { MultiRiderPeers } from '@/components/ride/MultiRiderPeers';
import { waitForContainerSize } from '@/lib/waitForContainerSize';
import {
  CHASE_FRAMING,
  chasePitchRad,
  computeCameraPose,
  easedCameraTransition,
  riderAimPitchRad,
  sideTrackSideFromPose,
  type CameraPose,
  type SideTrackCorridor,
} from '@/lib/cesiumCameras';
import {
  createRoadEntity,
  createRoadEdgeStripes,
  createKmMarkers,
  createClimbArches,
  type RoadEntityHandle,
  type EdgeStripesHandle,
  type KmMarkersHandle,
  type ClimbArchesHandle,
} from '@/lib/routeSurface';
import { tryEnableHDR } from '@/lib/cesiumHDR';
import { attachScenePerf } from '@/lib/perf/scenePerf';
import { createPerfGovernor, type PerfGovernor } from '@/lib/perf/perfGovernor';
import { shouldRenderOnDemand } from '@/lib/perf/renderMode';
import { useMultiriderStore } from '@/stores/multiriderStore';
import { canvasKeyFor, useWorldViewStore } from '@/stores/worldViewStore';
import { watchContextLoss } from '@/renderers/contextLoss';

function cesiumDebugOptedIn(): boolean {
  if (typeof window === 'undefined') return false;
  if (import.meta.env.DEV) return true;
  try {
    return window.localStorage.getItem('velo.debug.cesium') === '1';
  } catch {
    return false;
  }
}

/** Altitude threshold below which Google Photorealistic 3D Tiles are shown. */
const PHOTOREAL_SHOW_ALTITUDE_M = 5_000;

/**
 * Disable photoreal on mobile (< 6 hardware cores) — the chase-cam altitude
 * keeps tiles in constant view, which can drop 40+ FPS on a phone GPU.
 */
const PHOTOREAL_MOBILE_DISABLED = (navigator.hardwareConcurrency ?? 8) < 6;

// Ghost avatar appearance — desaturated pale blue, semi-transparent feel.
// We pass real hex colors; the avatar entity materials carry opacity via
// Cesium.Color alpha (set in the ghost setup function below).
const GHOST_COLORS: AvatarColors = {
  frame: '#94a3b8',
  wheel: '#475569',
  kit: '#bae6fd',
  skin: '#cbd5e1',
  helmet: '#7dd3fc',
  accent: '#93c5fd',
};

/**
 * The route's own cinematic mood: IconicRoute catalog → Easy & Scenic →
 * WorldTourStage catalog → distance/ascent heuristic. Live weather may
 * replace it (see lib/meteo/sceneWeather).
 */
function cannedMoodForRoute(route: Route): MoodId {
  const iconicMatch = ICONIC_ROUTES.find((r) => r.route.id === route.id);
  if (iconicMatch?.mood) return iconicMatch.mood as MoodId;
  const scenicMatch = scenicRouteById(route.id);
  if (scenicMatch) return scenicMatch.mood;
  const wtsMatch = WORLD_TOUR_STAGES.find((st) => st.route.id === route.id);
  if (wtsMatch?.info.mood) return wtsMatch.info.mood as MoodId;
  return moodForRoute(route);
}

// Camera transition duration in milliseconds.
const CAM_TRANSITION_MS = 1200;

/** How long the blob-shadow sun position stays cached (it moves ~0.25°/min). */
const SUN_CACHE_MS = 5_000;
/** Ground samplers for the side / orbit camera, one per scene (photoreal mesh aware). */
const cameraGroundSamplers = new WeakMap<Cesium.Scene, ReturnType<typeof createGroundSampler>>();
/** The chase camera never dips closer than this to the terrain under it (m). */
const CHASE_MIN_CLEARANCE_M = 1.2;

type CesiumWorldViewProps = WorldViewProps & {
  /**
   * Called once the Cesium.Viewer is fully constructed (legacy hook; new
   * callers use `onReady`, whose WorldRenderer carries the viewer as `native`).
   */
  onViewerReady?: (viewer: Cesium.Viewer) => void;
};

/**
 * What a viewer reports about its WebGL context, for the canvas key it was
 * built under (stores/worldViewStore counts a report only for the slot
 * owner's current key, so a torn-down viewer's late events are ignored).
 */
export interface ViewerContextReport {
  /** The context is gone, or no viewer could be built: the world is frozen. */
  lost: (canvasKey: number) => void;
  /** The browser gave the context back: build the viewer again. */
  restored: (canvasKey: number) => void;
}

/**
 * The photoreal renderer ('photoreal' behind lib/world/renderer.ts): Cesium
 * globe + terrain + OSM buildings + the route polyline + a multi-part bike
 * avatar that tracks the rider's pose from lib/ride/rideSim. The camera
 * follows the avatar when riding, and frames the entire route when idle so
 * the user can preview before clicking Start.
 *
 * A lost WebGL context (a GPU reset, a driver update, Chrome's GPU watchdog
 * or its cap on live contexts; card t_771036a6): Cesium has no restore path
 * of its own, so this view owns the world-view slot (stores/worldViewStore)
 * while mounted. The ride's status chip says "3D view stopped · tap to
 * reload" and the dead view is hidden; a browser restore or the rider's tap
 * bumps the canvas key, which remounts CesiumScene on a new Viewer, and that
 * Viewer's WorldRenderer goes to the ride view through `onReady` again. The
 * ride loop, its clock and the recording never depend on the viewer.
 *
 * Opt-in and lazy: only src/renderers/registry.ts imports this module, via
 * import(), so the Cesium chunk loads only when this renderer draws.
 */
export function CesiumWorldView(props: CesiumWorldViewProps) {
  const [viewId, setViewId] = useState(0);
  // The id the viewer's reports go to: set in the attach effect itself, so a
  // viewer that fails to build right after mount still reaches the slot. (A
  // report after the view left is ignored: detach cleared the slot.)
  const viewIdRef = useRef(0);
  useEffect(() => {
    const id = useWorldViewStore.getState().attach();
    viewIdRef.current = id;
    setViewId(id);
    return () => useWorldViewStore.getState().detach(id);
  }, []);
  const canvasKey = useWorldViewStore((s) => canvasKeyFor(s, viewId));
  // A lost view is hidden until it remounts: a dead WebGL canvas paints white
  // (with a broken-image glyph) and Cesium may put its "Rendering has
  // stopped" panel over it; the plain ride background is calmer.
  const contextLost = useWorldViewStore((s) => s.view !== null && s.view.id === viewId && s.view.stopped);
  const [report] = useState<ViewerContextReport>(() => ({
    lost: (key) => {
      if (viewIdRef.current) useWorldViewStore.getState().contextLost(viewIdRef.current, key);
    },
    restored: (key) => {
      if (viewIdRef.current) useWorldViewStore.getState().contextRestored(viewIdRef.current, key);
    },
  }));
  return (
    <div
      className={contextLost ? 'absolute inset-0 invisible' : 'absolute inset-0'}
      data-world-context={contextLost ? 'lost' : 'live'}
    >
      <CesiumScene key={canvasKey} {...props} canvasKey={canvasKey} context={report} />
    </div>
  );
}

/**
 * One Cesium Viewer and everything drawn in it. CesiumWorldView remounts it
 * (a new `key` = `canvasKey`) to rebuild the world on a fresh WebGL context.
 */
export function CesiumScene({
  ionToken,
  onReady,
  onViewerReady,
  canvasKey,
  context,
}: CesiumWorldViewProps & {
  /** The key this scene is mounted under (its reports carry it). */
  canvasKey: number;
  /** Where the viewer's canvas reports its WebGL context. */
  context: ViewerContextReport;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  /** Lift applied to the side / orbit camera over buildings and walls (m). */
  const cameraLiftRef = useRef(0);
  /** Last side the side-tracking camera used (+1 right / -1 left) — hysteresis. */
  const sideTrackSideRef = useRef<1 | -1>(1);
  /** Keeps the side / orbit camera out of the mesh and in sight of the rider (lib/sideCamSight). */
  const [sideCamSight] = useState(createSideCamSight);
  const sideCamSightRef = useRef(sideCamSight);
  /** Cuts across the road seen so far (a cut drops the lift). */
  const sideCamCutsRef = useRef(0);
  // The old single-colour polyline is replaced by gradient segments + markers.
  // Keep routePolylineRef so the searchPin effect can coexist unchanged.
  const routePolylineRef = useRef<Cesium.Entity | null>(null);
  const gradientSegmentsRef = useRef<GradientSegment[]>([]);
  const routeMarkersRef = useRef<RouteMarkers | null>(null);
  const avatarRef = useRef<Avatar | null>(null);
  const cartesianRouteRef = useRef<Cesium.Cartesian3[] | null>(null);
  const tilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);
  // Separate ref for OSM buildings so it never overwrites tilesetRef (which
  // applyGraphicsQuality uses to tune the photoreal tileset's SSE budget).
  const osmTilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const photorealPromiseRef = useRef<Promise<Cesium.Cesium3DTileset> | null>(null);
  const removeTickRef = useRef<(() => void) | null>(null);
  const detachPerfRef = useRef<(() => void) | null>(null);
  /** Stops the watch on the viewer canvas's WebGL context (renderers/contextLoss). */
  const stopContextWatchRef = useRef<(() => void) | null>(null);
  // Adaptive quality governor — steps scene cost down when real frames run
  // over budget (see lib/perf/perfGovernor). Recreated on quality-tier change.
  const perfGovernorRef = useRef<PerfGovernor | null>(null);
  // Cached sun position for the blob shadow (recomputed at most every SUN_CACHE_MS).
  const sunCacheRef = useRef<{ t: number; azimuth: number; altitude: number } | null>(null);
  const makePerfGovernor = (viewer: Cesium.Viewer): PerfGovernor => {
    perfGovernorRef.current?.dispose();
    const governor = createPerfGovernor({
      viewer,
      getTilesets: () => [tilesetRef.current, osmTilesetRef.current],
    });
    perfGovernorRef.current = governor;
    // Debug/perf hook alongside window.__veloPerf (lib/perf/scenePerf).
    if (typeof window !== 'undefined') {
      (window as unknown as { __veloPerfGovernor?: () => object }).__veloPerfGovernor =
        () => governor.state();
    }
    return governor;
  };
  // Ghost rider refs — parallel arrays, one entry per active ghost.
  const ghostAvatarsRef = useRef<Avatar[]>([]);
  const ghostRidesRef = useRef<GhostRide[]>([]);
  // Pace bot avatar refs — one Avatar per active bot, parallel to rideStore.paceBots.
  const botAvatarsRef = useRef<Avatar[]>([]);
  // Weather particle system — recreated on route change and quality change.
  const weatherSystemRef = useRef<WeatherSystem | null>(null);
  // Cloud collection + shadow entity — created on route load.
  const cloudCollectionRef = useRef<Cesium.CloudCollection | null>(null);
  const shadowHandleRef = useRef<ShadowHandle | null>(null);
  const skyCleanupRef = useRef<(() => void) | null>(null);
  // Spectator crowds — rebuilt on route change; null when the route has no spectator zones.
  const spectatorCollectionRef = useRef<SpectatorCollection | null>(null);
  // Pre-computed along-route distance for each spectator (parallel array).
  const spectatorDistancesRef = useRef<number[]>([]);
  // Road material saved before the wet surface replaced it, so a live change
  // from rain to dry can put it back. Null while the road is dry.
  const dryMaterialsRef = useRef<{ corridor: unknown } | null>(null);
  // Scene currently applied (live or canned); read by the quality effect.
  const appliedSceneRef = useRef<SceneWeather | null>(null);
  // Live polyline entity for outdoor GPS mode.
  const livePolylineEntityRef = useRef<Cesium.Entity | null>(null);
  // ---- Road surface ----
  const roadEntityRef = useRef<RoadEntityHandle | null>(null);
  const roadEdgeStripesRef = useRef<EdgeStripesHandle | null>(null);
  const kmMarkersRef = useRef<KmMarkersHandle | null>(null);
  const climbArchesRef = useRef<ClimbArchesHandle | null>(null);
  // Multi-rider peers: state to trigger re-render when viewer is ready.
  // Monotonically increasing on each viewer creation. Used as a dependency so
  // viewer-bound effects re-run when StrictMode unmounts + remounts (which
  // tears down the first viewer + creates a fresh one). A plain boolean
  // wouldn't fire dependent effects on remount because false → true only
  // changes once across the component's lifetime. `0` = not yet ready.
  const [viewerReady, setViewerReady] = useState(0);

  // Camera transition state held across frames.
  const camTransitionRef = useRef<{
    fromPose: CameraPose;
    startMs: number;
  } | null>(null);
  const lastCamPoseRef = useRef<CameraPose | null>(null);
  // Track which mode was active last frame so we can detect mode changes.
  const lastCamModeRef = useRef<string>('chase');
  const laneRef = useRef(createLaneState());
  // WorldRenderer.setRider: an outside driver's pose; null = the live ride.
  const riderOverrideRef = useRef<RiderPose | null>(null);
  /** Is the ground under the waiting rider at full detail (the start waits for it, lib/ride/startHold)? */
  const startGroundRef = useRef<StartGroundWatch | null>(null);
  /** The crop that frames the rider above the floating window's bar (hudLensCrop); none in the tab. */
  const lensCropRef = useRef<LensCropState | null>(null);
  /** Is the globe drawn, or is the photoreal mesh the one ground (renderers/cesium/globeGate)? */
  const globeGateRef = useRef(new GlobeGate());
  // WorldRenderer.setMood: a pinned mood; null = route mood + live weather.
  const [moodOverride, setMoodOverride] = useState<MoodId | null>(null);

  const route = useRideStore((s) => s.route);

  // Live weather for the route start drives the atmosphere when enabled.
  const liveWeatherEnabled = useSettingsStore((s) => s.liveWeatherEnabled);
  const weatherEntry = useRouteWeather(route);
  const liveWeather = weatherEntry?.status === 'ready' ? weatherEntry.weather : null;
  const atmosphere = useMemo(
    () =>
      route
        ? moodOverride
          ? cannedScene(moodOverride)
          : resolveSceneWeather(cannedMoodForRoute(route), liveWeather, liveWeatherEnabled)
        : null,
    [route, liveWeather, liveWeatherEnabled, moodOverride],
  );
  const atmosphereKey = atmosphere ? sceneKey(atmosphere) : 'none';
  const rideMode = useRideStore((s) => s.rideMode);
  const livePolyline = useRideStore((s) => s.livePolyline);
  const flyToTarget = useRideStore((s) => s.flyToTarget);
  const searchPinRef = useRef<Cesium.Entity | null>(null);
  const theme = useThemeStore((s) => s.theme);
  const avatarColors = useSettingsStore((s) => s.avatar);
  const graphicsQuality = useSettingsStore((s) => s.graphicsQuality);
  const ghostsEnabled = useGhostStore((s) => s.ghostsEnabled);

  // Play mode (postcards + riding buddy) manages its own entities and frame hook.
  usePlayLayer(viewerReady ? viewerRef.current : null, route);

  // ---- Bootstrap viewer ----
  useEffect(() => {
    if (!containerRef.current) return;

    // cancelled flag — set by cleanup if the component unmounts before the
    // async container-size wait resolves (e.g. rapid route navigation).
    let bootstrapCancelled = false;

    // ResizeObserver is hoisted to effect scope (outside the async IIFE) so
    // the synchronous cleanup `return` can always call ro.disconnect(), even
    // if the component unmounts before waitForContainerSize resolves.
    const ro = new ResizeObserver(() => {
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.resize();
        viewerRef.current.resolutionScale = resolutionScaleFor(
          useSettingsStore.getState().graphicsQuality,
          viewerRef.current.canvas.clientWidth,
          viewerRef.current.canvas.clientHeight,
        );
        viewerRef.current.scene.requestRender();
      }
    });
    ro.observe(containerRef.current);

    void (async () => {
      const container = containerRef.current!;

      // Install the token (or clear any inherited default if null). The
      // helpers downstream (setupBaseImagery, getTerrainProvider,
      // getPhotorealTileset) branch on hasIonToken() so the no-token path
      // never makes ion network calls.
      setIonToken(ionToken);
      // Cesium World Terrain (ion asset 1): its endpoint and layer.json are
      // asked for before the Viewer is built (a long synchronous constructor
      // on a busy laptop), not when the browser goes idle. The ride start
      // waits for it (lib/ride/startHold); the promise is cached, so an
      // unmount here leaves nothing to clean up.
      const worldTerrain = getTerrainProvider();
      worldTerrain.catch(() => undefined);

      // Defensive mount-timing guard: wait until the container
      // has positive layout dimensions before constructing the Cesium Viewer.
      // The ride view is a full-page route so the race is rare in practice,
      // but React StrictMode double-invocation and fast navigation can trigger
      // a 0×0 canvas on the first mount pass. waitForContainerSize resolves
      // immediately when dimensions are already positive (the common path).
      await waitForContainerSize(container);
      if (bootstrapCancelled || !containerRef.current) return;

      let viewer: Cesium.Viewer;
      try {
        viewer = new Cesium.Viewer(container, {
          timeline: false,
          animation: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: false,
          sceneModePicker: false,
          selectionIndicator: false,
          navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
          // No default base layer: setupBaseImagery() below adds exactly one
          // (Bing via ion with its stall watchdog, or OSM without a token).
          // The Viewer's own default is the same Bing layer, so keeping it
          // stacked two opaque copies — every imagery tile fetched, decoded,
          // uploaded and sampled twice.
          baseLayer: false,
          // Mark the WebGL context as XR-compatible so that
          // navigator.xr.requestSession('immersive-vr' | 'immersive-ar') can use
          // this canvas. xrCompatible is a valid WebGL context attribute (WebXR
          // spec) but isn't typed in Cesium's WebGLOptions — cast to satisfy tsc.
          contextOptions: { webgl: { xrCompatible: true } as Cesium.WebGLOptions },
        });
      } catch (err) {
        // No WebGL context to be had right now (the GPU process is still
        // down, or Chrome blocked WebGL after repeated crashes): the view
        // stays stopped, so the chip stays up and a tap tries again.
        console.warn('[velo] the photoreal view could not start:', err);
        context.lost(canvasKey);
        return;
      }
      viewerRef.current = viewer;
      // A lost context freezes the canvas for good (Cesium never restores
      // one): report it, so the chip shows and a restore or a tap remounts
      // this scene on a new Viewer. Stopped first thing in the cleanup.
      stopContextWatchRef.current = watchContextLoss(viewer.scene.canvas, {
        lost: () => context.lost(canvasKey),
        restored: () => context.restored(canvasKey),
      });
      // In the floating ride window the bar covers the bottom of the picture
      // (data-hud-bottom): draw a taller canvas cropped by the window, so the
      // rider sits in the clear band above the bar (hudLensCrop). Checked
      // before every frame, ahead of its camera and canvas size.
      const lensView = { container, camera: viewer.camera, resize: () => viewer.resize() };
      const lensCrop = lensCropState(lensView);
      lensCropRef.current = lensCrop;
      viewer.scene.preUpdate.addEventListener(() => {
        applyHudLensCrop(lensView, lensCrop);
      });
      // Assigned as soon as it arrives (its tiles stream over the next frames);
      // on a busy laptop an idle callback alone sat out its 2 s timeout.
      worldTerrain
        .then((terrain) => {
          if (viewer.isDestroyed()) return;
          viewer.scene.terrainProvider = terrain;
        })
        .catch(() => undefined);
      // Scene handle for render probes (scripts/ride-surface-probe.py): dev
      // builds, or `localStorage['velo.debug.cesium'] = '1'` (as velo.debug.three).
      // `place(m)` holds the rider at a route distance (null releases it).
      if (cesiumDebugOptedIn()) {
        (window as unknown as { __veloCesium?: unknown }).__veloCesium = {
          viewer,
          Cesium,
          photoreal: () => tilesetRef.current,
          globeGate: globeGateRef.current,
          place: (distanceM: number | null) => {
            const r = useRideStore.getState().route;
            riderOverrideRef.current = distanceM === null || !r ? null : ridePose(r, distanceM);
          },
        };
      }
      // Frame-time + tile-load stats (?perf=1 overlay, window.__veloPerf).
      detachPerfRef.current = attachScenePerf(viewer);
      // Adaptive quality governor — measures from the first rendered frame
      // and steps scene cost down when the budget is missed.
      makePerfGovernor(viewer);
      setViewerReady((n) => n + 1);
      // Notify the parent so EnterVRButton (and other consumers) can hold a
      // ref to the viewer for XR session entry.
      onViewerReady?.(viewer);
      onReady?.(
        createCesiumWorldRenderer(viewer, {
          setRiderOverride: (pose) => {
            riderOverrideRef.current = pose;
          },
          setMoodOverride,
          groundStable: () => startGroundRef.current?.ready === true,
        }),
      );

    // Add Bing Maps Aerial as the permanent globe base layer so terrain is
    // always visible — even in rural areas where Google Photorealistic Tiles
    // have no coverage.  This must come before the photoreal tileset is added
    // so imagery is rendered under it whenever tiles are absent.
    setupBaseImagery(viewer).catch(() => undefined);

    const scene = viewer.scene;
    scene.globe.depthTestAgainstTerrain = true;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    scene.globe.enableLighting = true;

    // Shadow entity is created once per viewer lifetime; position is updated
    // per-frame in the preRender handler.
    shadowHandleRef.current = createShadowEntity(viewer);

    // Apply the persisted graphics quality tier (AA, shadows, fog).
    // Fog is always enabled; density is controlled per-tier.
    scene.fog.enabled = true;
    // Until the rider picks a tier, choose one for this GPU (balanced on
    // integrated GPUs like the Arc iGPU, high on discrete cards).
    if (useSettingsStore.getState().graphicsQualityAuto) {
      const gl = (scene as unknown as { context?: { _gl?: WebGLRenderingContext } }).context?._gl;
      const recommended = recommendedGraphicsQuality(
        webglRenderer(gl),
        window.matchMedia?.('(pointer: coarse)').matches ?? false,
      );
      if (recommended !== useSettingsStore.getState().graphicsQuality) {
        useSettingsStore.getState().setSettings({ graphicsQuality: recommended });
      }
    }
    const initialQuality = useSettingsStore.getState().graphicsQuality;
    applyGraphicsQuality(viewer, initialQuality);
    // Cinematic post-process stages (bloom, AO, vignette/grade) — created
    // once and enabled/disabled by quality tier. Must come after the viewer
    // is fully constructed so scene.postProcessStages is available.
    applyCinematicEffects(viewer, initialQuality);

    // Render resolution comes from the tier (applyGraphicsQuality): a
    // fraction of the CSS size, capped to the tier's pixel budget.

    // Defer the expensive scene additions (HDR, terrain, OSM buildings,
    // photoreal tiles) until the browser is idle. Without this, the JS
    // thread is blocked during initial mount and React can't process
    // user input — including the Start-ride button click — for several
    // seconds.
    const scheduleIdle = (fn: () => void): void => {
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
      if (typeof ric === 'function') {
        ric(fn, { timeout: 2000 });
      } else {
        setTimeout(fn, 0);
      }
    };

    scheduleIdle(() => {
      if (viewer.isDestroyed()) return;
      // HDR + ACES filmic tonemapping — richer colour on capable platforms.
      // Skip on 'low' quality tier (power-saver devices).
      if (initialQuality !== 'low') {
        tryEnableHDR(viewer);
      }
    });

    // OSM buildings + Google Photoreal 3D Tiles are the heaviest single
    // contributors to first-frame jank. Hold them back further so the
    // ride view becomes interactive immediately, then layer them in.
    //
    // Both assets are ion-hosted (OSM buildings = ion asset 96188, photoreal
    // = 2275207), so we skip the network calls entirely when no token is
    // installed. The OSM imagery base layer is enough to make the world
    // legible — buildings + photoreal mesh are bonus content that arrives
    // with the ion upgrade.
    scheduleIdle(() => {
      if (viewer.isDestroyed()) return;
      if (!hasIonToken()) return;

      const usePhotoreal = import.meta.env.VITE_PHOTOREAL_TILES !== 'false';

      Cesium.createOsmBuildingsAsync()
        .then((tileset) => {
          if (viewer.isDestroyed()) {
            tileset.destroy?.();
            return;
          }
          viewer.scene.primitives.add(tileset);
          osmTilesetRef.current = tileset;
        })
        .catch(() => undefined);

      if (usePhotoreal && !PHOTOREAL_MOBILE_DISABLED) {
        const photoreal = getPhotorealTileset();
        photorealPromiseRef.current = photoreal;
        photoreal
          .then((tileset) => {
            if (viewer.isDestroyed()) {
              tileset.destroy?.();
              return;
            }
            tileset.show = false;
            viewer.scene.primitives.add(tileset);
            tilesetRef.current = tileset;
            // The tier's detail budget (the tileset is created after the
            // bootstrap applied the tier to the scene).
            applyGraphicsQuality(viewer, useSettingsStore.getState().graphicsQuality, tileset);
          })
          .catch(() => {
            photorealPromiseRef.current = null;
          });
      }
    });

    })(); // end async bootstrap IIFE

    return () => {
      // Signal the async init to bail out if it hasn't constructed the viewer
      // yet (e.g. unmount before waitForContainerSize resolves).
      bootstrapCancelled = true;
      // Tearing the viewer down is not a loss the rider needs to hear about.
      stopContextWatchRef.current?.();
      stopContextWatchRef.current = null;
      ro.disconnect();
      if (typeof window !== 'undefined') delete (window as unknown as { __veloCesium?: unknown }).__veloCesium;

      // All mutable state below is read from refs, not the async-IIFE-local
      // `viewer` const, so cleanup is safe regardless of init completion order.
      const viewer = viewerRef.current;

      removeTickRef.current?.();
      removeTickRef.current = null;
      detachPerfRef.current?.();
      detachPerfRef.current = null;
      perfGovernorRef.current?.dispose();
      perfGovernorRef.current = null;
      // Dispose weather system before destroying the viewer.
      weatherSystemRef.current?.dispose();
      weatherSystemRef.current = null;
      skyCleanupRef.current?.();
      skyCleanupRef.current = null;
      shadowHandleRef.current?.destroy();
      shadowHandleRef.current = null;
      if (viewer && cloudCollectionRef.current && !viewer.isDestroyed()) {
        try { viewer.scene.primitives.remove(cloudCollectionRef.current); } catch { /* torn down */ }
      }
      cloudCollectionRef.current = null;
      // Dispose ghost avatars — viewer.entities.remove needs isDestroyed guard.
      for (const ga of ghostAvatarsRef.current) {
        if (viewer && !viewer.isDestroyed()) ga.dispose();
      }
      ghostAvatarsRef.current = [];
      ghostRidesRef.current = [];
      // Dispose pace bot avatars.
      for (const ba of botAvatarsRef.current) {
        if (viewer && !viewer.isDestroyed()) ba.dispose();
      }
      botAvatarsRef.current = [];
      // Explicitly destroy tileset GPU resources after removal.
      // Cesium's primitives.remove() does NOT free VRAM unless the scene was
      // constructed with destroyPrimitives:true (we don't set that flag).
      // Calling destroy() here is the only reliable way to prevent VRAM leaks
      // on rapid route changes and mobile OOM situations.
      if (tilesetRef.current && viewer && !viewer.isDestroyed()) {
        try {
          viewer.scene.primitives.remove(tilesetRef.current);
          if (!tilesetRef.current.isDestroyed()) tilesetRef.current.destroy();
        } catch {
          // Scene or tileset may already be in a torn-down state — ignore.
        }
      }
      tilesetRef.current = null;
      if (osmTilesetRef.current && viewer && !viewer.isDestroyed()) {
        try {
          viewer.scene.primitives.remove(osmTilesetRef.current);
          if (!osmTilesetRef.current.isDestroyed()) osmTilesetRef.current.destroy();
        } catch {
          // Scene or tileset may already be in a torn-down state — ignore.
        }
      }
      osmTilesetRef.current = null;
      // Tear down spectator collection.
      spectatorCollectionRef.current?.destroy();
      spectatorCollectionRef.current = null;
      spectatorDistancesRef.current = [];
      // ---- Road surface cleanup ----
      roadEntityRef.current?.destroy();
      roadEntityRef.current = null;
      roadEdgeStripesRef.current?.destroy();
      roadEdgeStripesRef.current = null;
      kmMarkersRef.current?.destroy();
      kmMarkersRef.current = null;
      climbArchesRef.current?.destroy();
      climbArchesRef.current = null;
      if (viewer && !viewer.isDestroyed()) destroyCinematicEffects(viewer);
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      // The side camera's sight kept copies of this view's tile geometry.
      clearMeshTopReads();
      viewerRef.current = null;
      // Don't reset to 0 — keeping the counter forward-only means a future
      // remount produces n+2 (distinct from the prior n+1) and dependent
      // effects re-run cleanly.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Theme-driven scene background ----
  // Cesium clears with this color before the globe renders, so it shows
  // through during loading and at the poles where the atmosphere thins.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(
      theme === 'dark' ? '#0b1220' : '#dfe7f1',
    );
  }, [theme]);

  // ---- Re-apply graphics quality when the user changes the tier ----
  // Also recreate the weather system at the new particle count budget.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    applyGraphicsQuality(viewer, graphicsQuality, tilesetRef.current);
    applyCinematicEffects(viewer, graphicsQuality);
    // The tier change re-applied the baseline quality — restart the governor
    // from level 0 so it re-measures against the new tier.
    makePerfGovernor(viewer);

    // Rebuild weather system at new quality budget when a route is loaded.
    const applied = appliedSceneRef.current;
    if (applied && weatherSystemRef.current) {
      weatherSystemRef.current.dispose();
      weatherSystemRef.current = createWeatherSystem(viewer, applied.particles, graphicsQuality);
    }
  }, [graphicsQuality]);

  // ---- Render on demand while nothing moves (paused / finished) ----
  const rideStateForRender = useRideStore((s) => s.rideState);
  const peerCount = useMultiriderStore((s) => Object.keys(s.peers).length);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const onDemand = shouldRenderOnDemand(rideStateForRender, peerCount);
    viewer.scene.requestRenderMode = onDemand;
    viewer.scene.maximumRenderTimeChange = Number.POSITIVE_INFINITY;
    viewer.scene.requestRender();
    if (!onDemand) return;
    // Any setting can change the picture (camera mode/distance, quality,
    // colours): draw one fresh frame when one does.
    return useSettingsStore.subscribe(() => {
      if (!viewer.isDestroyed()) viewer.scene.requestRender();
    });
  }, [rideStateForRender, peerCount, viewerReady]);

  // ---- Live avatar recolouring from the Garage settings ----
  useEffect(() => {
    avatarRef.current?.setColors(avatarColors);
  }, [avatarColors]);

  // ---- Rebuild route entities + avatar when route changes ----
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    // Tear down previous route visuals.
    // Guard viewer.isDestroyed() — the viewer may have been destroyed between
    // the previous render and this effect re-running (e.g. fast route switching).
    if (routePolylineRef.current) {
      if (!viewer.isDestroyed()) viewer.entities.remove(routePolylineRef.current);
      routePolylineRef.current = null;
    }
    if (gradientSegmentsRef.current.length > 0) {
      if (!viewer.isDestroyed()) removeGradientPolylines(viewer, gradientSegmentsRef.current);
      gradientSegmentsRef.current = [];
    }
    if (routeMarkersRef.current) {
      if (!viewer.isDestroyed()) removeRouteMarkers(viewer, routeMarkersRef.current);
      routeMarkersRef.current = null;
    }
    if (avatarRef.current) {
      avatarRef.current.dispose();
      avatarRef.current = null;
    }
    // Tear down ghost avatars from previous route.
    for (const g of ghostAvatarsRef.current) {
      if (!viewer.isDestroyed()) g.dispose();
    }
    ghostAvatarsRef.current = [];
    ghostRidesRef.current = [];
    useGhostStore.getState().setGhostCount(0);
    // Tear down pace bot avatars from previous route.
    for (const ba of botAvatarsRef.current) {
      if (!viewer.isDestroyed()) ba.dispose();
    }
    botAvatarsRef.current = [];
    cartesianRouteRef.current = null;
    resetFollowCam();

    // Reset camera transition state so new routes start cleanly.
    camTransitionRef.current = null;
    lastCamPoseRef.current = null;
    lastCamModeRef.current = useSettingsStore.getState().cameraMode;

    // Dispose the previous weather system before building a new one.
    weatherSystemRef.current?.dispose();
    weatherSystemRef.current = null;
    // Tear down previous clouds + sky animation.
    skyCleanupRef.current?.();
    skyCleanupRef.current = null;
    if (cloudCollectionRef.current && !viewer.isDestroyed()) {
      try { viewer.scene.primitives.remove(cloudCollectionRef.current); } catch { /* torn down */ }
      cloudCollectionRef.current = null;
    }

    spectatorCollectionRef.current?.destroy();
    spectatorCollectionRef.current = null;
    spectatorDistancesRef.current = [];
    dryMaterialsRef.current = null;

    // ---- Road surface — tear down previous surface ----
    roadEntityRef.current?.destroy();
    roadEntityRef.current = null;
    roadEdgeStripesRef.current?.destroy();
    roadEdgeStripesRef.current = null;
    kmMarkersRef.current?.destroy();
    kmMarkersRef.current = null;
    climbArchesRef.current?.destroy();
    climbArchesRef.current = null;

    // A new route starts on the globe until the mesh under the new rider loads.
    globeGateRef.current.reset();
    if (!viewer.isDestroyed()) viewer.scene.globe.show = true;

    if (!route) return;

    // Mood, sky, clouds, particles and the wet road are applied by the
    // atmosphere effect below, which also reacts to live weather.

    const positions = routeToCartesians(route);
    cartesianRouteRef.current = positions;

    // Build gradient-coloured polyline segments.
    const segments = buildGradientPolylines(viewer, route, positions);
    gradientSegmentsRef.current = segments;

    // Build start / finish / km markers.
    routeMarkersRef.current = buildRouteMarkers(viewer, route, positions);

    // ---- Road surface ----
    // Build corridor + edge stripes + km markers + climb arches once per route.
    // The corridor replaces the thin polyline visually; gradient polylines remain
    // for the elevation-profile colour data but are now underlaid by the surface.
    roadEntityRef.current = createRoadEntity(viewer, route, positions);
    roadEdgeStripesRef.current = createRoadEdgeStripes(viewer, route);
    kmMarkersRef.current = createKmMarkers(viewer, route, positions);
    climbArchesRef.current = createClimbArches(viewer, route, positions);

    // Only World Tour routes with spectatorClimbs defined get crowds.
    const spectZones = spectatorZonesForRoute(route);
    if (spectZones.length > 0 && !viewer.isDestroyed()) {
      const quality = useSettingsStore.getState().graphicsQuality;
      const spectPositions = generateSpectatorPositions(route, spectZones, quality);
      if (spectPositions.length > 0) {
        spectatorCollectionRef.current = createSpectatorBillboards(viewer, spectPositions);
        spectatorDistancesRef.current = buildSpectatorDistanceIndex(
          spectZones, spectPositions, route, quality,
        );
      }
    }

    // With photoreal tiles the GPX elevations don't match the rendered
    // surface — clamp all segment positions onto the real surface once
    // tiles have streamed in, then update each segment's position property.
    const pr = photorealPromiseRef.current;
    if (pr) {
      const capturedSegments = segments;
      pr
        .then(() => clampCartesiansToScene(viewer.scene, positions, 1.5))
        .then((clamped) => {
          if (viewer.isDestroyed()) return;
          // Re-slice clamped positions back into each segment.
          for (const seg of capturedSegments) {
            if (!viewer.entities.contains(seg.entity)) continue;
            const segPositions = clamped.slice(seg.startIdx, seg.endIdx + 1);
            if (seg.entity.polyline) {
              seg.entity.polyline.positions = new Cesium.ConstantProperty(segPositions);
            }
          }
        })
        .catch(() => undefined);
    }

    const avatar = createAvatar(viewer);
    avatar.setColors(useSettingsStore.getState().avatar);
    avatarRef.current = avatar;

    // ---- Pace bot avatars — one per bot in the current roster ----
    // Read synchronously; if the user adds bots after route load the preRender
    // handler will detect the count mismatch and skip (bots won't render until
    // the next route load or a manual rebuild — acceptable for the first ship).
    // Each is placed on the route at creation (the start line after a load).
    botAvatarsRef.current = placeBotAvatars(useRideStore.getState().paceBots, route, () => createAvatar(viewer));

    const start = route.points[0];
    avatar.update({
      lon: start.lon,
      lat: start.lat,
      ele: start.ele,
      heading: headingAt(route, 0),
      speed: 0,
      cadence: 0,
      grade: 0,
      dt: 0,
      riderPosition: useSettingsStore.getState().riderPosition,
    });

    // Load ghost riders for this route asynchronously so it never blocks rendering.
    const capturedRoute = route;
    const capturedViewer = viewer;
    loadGhosts(route).then((ghosts) => {
      if (capturedViewer.isDestroyed()) return;
      // Route may have changed while the async load was in flight.
      if (useRideStore.getState().route !== capturedRoute) return;
      if (!useGhostStore.getState().ghostsEnabled || ghosts.length === 0) {
        useGhostStore.getState().setGhostCount(0);
        return;
      }
      const start = capturedRoute.points[0];
      const avatars: Avatar[] = ghosts.map(() => {
        const ga = createAvatar(capturedViewer);
        ga.setColors(GHOST_COLORS);
        // Place ghost at route start initially.
        ga.update({
          lon: start.lon,
          lat: start.lat,
          ele: start.ele,
          heading: headingAt(capturedRoute, 0),
          speed: 0,
          cadence: 0,
          grade: 0,
          dt: 0,
        });
        return ga;
      });
      ghostAvatarsRef.current = avatars;
      ghostRidesRef.current = ghosts;
      useGhostStore.getState().setGhostCount(ghosts.length);
    }).catch(() => {
      // Ghost loading failure is non-fatal — ride continues without ghosts.
    });

    flyToRoute(viewer, positions);
    // viewerReady is in the dep array because the viewer is created async
    // (Cesium ion + asset 2275207). If this effect first fires before the
    // viewer is ready, `viewerRef.current` is null and we bail on the guard
    // above; re-running once `viewerReady` flips true is what populates the
    // route polyline, gradient segments, markers, avatar, ghosts, and the
    // chase-cam target. Forgetting this dep was a real-browser-only bug —
    // local dev usually had a warm Cesium connection so the viewer was
    // ready before the effect ran.
  }, [route, viewerReady]);

  // ---- Atmosphere: mood, sky, clouds, particles, wet road ----
  // Live weather (Open-Meteo at the route start) when enabled and available,
  // otherwise the route's canned mood. Re-runs when the weather arrives or
  // changes, without rebuilding the route.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !route || !atmosphere) return;

    weatherSystemRef.current?.dispose();
    weatherSystemRef.current = null;
    skyCleanupRef.current?.();
    skyCleanupRef.current = null;
    if (cloudCollectionRef.current) {
      try { viewer.scene.primitives.remove(cloudCollectionRef.current); } catch { /* torn down */ }
      cloudCollectionRef.current = null;
    }

    const scene = atmosphere;
    appliedSceneRef.current = scene;
    const moodParams = MOODS[scene.mood];

    // Clock time drives the sun angle; atmosphere params set the sky.
    const mid = route.points[Math.floor(route.points.length / 2)];
    viewer.clock.currentTime = julianDateForMood(mid.lon, moodParams.sunHourFromNoon);
    viewer.clock.shouldAnimate = false;
    applySceneMood(viewer, scene.mood);

    const quality = useSettingsStore.getState().graphicsQuality;
    weatherSystemRef.current = createWeatherSystem(viewer, scene.particles, quality);
    skyCleanupRef.current = configureSky(viewer, moodParams.sky, mid.lon);
    cloudCollectionRef.current = spawnCumulusClouds(
      viewer,
      mid.lat,
      mid.lon,
      scaledCloudCount(scene.cloudCount ?? moodParams.sky.cloudCount, quality),
      moodParams.sky.cloudAltitudeM,
    );

    // Wet road: darken the corridor, remembering the dry material so a change
    // back to dry restores it. The gradient lines keep their colours.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const corridor = roadEntityRef.current?.entity.corridor as any;
    if (scene.wet) {
      if (corridor && !dryMaterialsRef.current) {
        dryMaterialsRef.current = { corridor: corridor.material };
      }
      if (corridor) corridor.material = createWetRoadSurfaceProperty();
    } else if (dryMaterialsRef.current) {
      if (corridor) corridor.material = dryMaterialsRef.current.corridor;
      dryMaterialsRef.current = null;
    }
    // Keyed on atmosphereKey, not `atmosphere`: a refreshed reading that
    // renders the same scene must not rebuild clouds and particles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, viewerReady, atmosphereKey]);

  // ---- React to route-search fly-to requests ----
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !flyToTarget) return;

    if (searchPinRef.current) {
      if (!viewer.isDestroyed()) viewer.entities.remove(searchPinRef.current);
      searchPinRef.current = null;
    }

    searchPinRef.current = viewer.entities.add({
      name: sanitizeForLabel(flyToTarget.label ?? 'Search target'),
      position: Cesium.Cartesian3.fromDegrees(flyToTarget.lon, flyToTarget.lat),
      point: {
        pixelSize: 14,
        color: Cesium.Color.fromCssColorString('#f59e0b'),
        outlineColor: Cesium.Color.fromCssColorString('#0b1220'),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: flyToTarget.label
        ? {
            text: sanitizeForLabel(flyToTarget.label),
            font: '14px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.fromCssColorString('#0b1220'),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -16),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          }
        : undefined,
    });

    flyToPoint(viewer, {
      lat: flyToTarget.lat,
      lon: flyToTarget.lon,
      boundingBox: flyToTarget.boundingBox,
    });
  }, [flyToTarget]);

  // Drop the pin once a real route loads — it's redundant alongside the polyline.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !route) return;
    if (searchPinRef.current) {
      if (!viewer.isDestroyed()) viewer.entities.remove(searchPinRef.current);
      searchPinRef.current = null;
    }
  }, [route]);

  // ---- Show/hide ghost avatars when the toggle changes ----
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const ghosts = ghostAvatarsRef.current;
    for (const ga of ghosts) ga.setShow(ghostsEnabled);
  }, [ghostsEnabled]);

  // ---- Per-frame follow-cam + avatar update ----
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    let lastFrameMs = performance.now();
    const handler = () => {
      const nowMs = performance.now();
      const dt = (nowMs - lastFrameMs) / 1000;
      lastFrameMs = nowMs;

      // Adaptive quality governor — measures every rendered frame, even
      // before a route loads (the globe alone can blow the budget).
      perfGovernorRef.current?.frame(nowMs);

      // --- Photoreal altitude gate — show only when camera is below 5 km ---
      let photorealShown = false;
      if (tilesetRef.current && !tilesetRef.current.isDestroyed()) {
        const altM = viewer.camera.positionCartographic.height;
        photorealShown = altM < PHOTOREAL_SHOW_ALTITUDE_M;
        tilesetRef.current.show = photorealShown;
      }
      // The photoreal mesh already has every building: drawing (and
      // streaming) the OSM extrusions on top doubles the work and z-fights.
      if (osmTilesetRef.current && !osmTilesetRef.current.isDestroyed()) {
        osmTilesetRef.current.show = !photorealShown;
      }

      const state = useRideStore.getState();
      const r = state.route;
      if (!r || !avatarRef.current) {
        globeGateRef.current.reset();
        viewer.scene.globe.show = true;
        return;
      }

      // Handlebar steering: drift across the lane, back to the line on release.
      stepLane(laneRef.current, activeSteer(), dt);

      // Rider pose from rideSim (or an outside driver via setRider), then the
      // scene height: GPX elevation on ion terrain, 0 m on the flat no-token globe.
      const pose =
        riderOverrideRef.current ??
        ridePose(r, state.distance, {
          laneOffsetM: laneRef.current.offsetM,
          grade: state.grade,
          speed: state.speed,
        });
      const aheadPose = ridePose(r, Math.min(r.totalDistance, pose.distance + 15), {
        laneOffsetM: pose.laneOffsetM,
        offsetHeading: pose.heading,
        grade: pose.grade,
      });
      const heading = pose.heading;
      const sampled = onSceneSurface({ lat: pose.lat, lon: pose.lon, ele: pose.ele });
      const ahead = onSceneSurface({ lat: aheadPose.lat, lon: aheadPose.lon, ele: aheadPose.ele });

      // One drawn ground: once the photoreal mesh is the road under the rider
      // the globe is hidden (it drew coarse terrain up to 26 m over the real
      // street on the Lugano shore, and the rider rode it); it comes back
      // where the mesh isn't the ground (renderers/cesium/globeGate). Decided
      // from the rider's last ground reading, before this frame's, so the
      // avatar below measures the ground as it will be drawn.
      const globeShown = globeGateRef.current.update(nowMs, photorealShown, avatarRef.current.meshGround());
      if (viewer.scene.globe.show !== globeShown) viewer.scene.globe.show = globeShown;
      // The painted road (asphalt corridor, dashed centre line, edge stripes)
      // is a ground classification: over the mesh it paints whatever stands
      // in its footprint (walls, trees, the hillside: the grey slabs on the
      // Lugano shore), a second road over the street the mesh already draws.
      // It shows only where the globe is the ground.
      const road = roadEntityRef.current;
      if (road && road.entity.show !== globeShown) {
        road.entity.show = globeShown;
        road.centerline.show = globeShown;
        for (const stripe of roadEdgeStripesRef.current?.entities ?? []) stripe.show = globeShown;
      }

      avatarRef.current.update({
        lon: sampled.lon,
        lat: sampled.lat,
        ele: sampled.ele,
        heading,
        speed: pose.speed,
        cadence: state.cadence,
        grade: pose.grade,
        dt,
        riderPosition: useSettingsStore.getState().riderPosition,
      });

      // Camera, weather and shadow sit on the SAME ground as the rider: the
      // rendered surface right now, never the route elevation while terrain
      // is still streaming (a slow phone otherwise hangs the camera ~300 m
      // over a black, empty globe with the rider out of sight).
      const groundEle = avatarRef.current.groundEle() ?? sampled.ele;
      // Before the start: is the ground under the rider plausible (no coarse chord)?
      // (Only once World Terrain is the globe's terrain; the flat globe has no finest level.)
      if (
        (state.rideState === 'idle' || state.rideState === 'ready') &&
        !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)
      ) {
        startGroundRef.current ??= new StartGroundWatch(async (lon, lat) => {
          const [c] = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [
            Cesium.Cartographic.fromDegrees(lon, lat),
          ]);
          return c.height;
        });
        const carto = Cesium.Cartographic.fromDegrees(sampled.lon, sampled.lat);
        const drawn = viewer.scene.globe.getHeight(carto);
        // With the globe hidden the mesh is the drawn ground: the globe's
        // refinement no longer matters (its tiles stop updating anyway).
        startGroundRef.current.update(sampled.lon, sampled.lat, drawn, groundEle, nowMs, !globeShown);
      }
      const aheadAtGround = { ...ahead, ele: groundEle + (ahead.ele - sampled.ele) };
      if (typeof window !== 'undefined') {
        // Read-only numbers for the slow-network regression check (no viewer handle).
        const riderLon = sampled.lon;
        const riderLat = sampled.lat;
        (window as unknown as { __veloRideDebug?: () => object }).__veloRideDebug = () => {
          if (viewer.isDestroyed()) return { destroyed: true };
          // Last side the side-tracking camera placed itself on (+1 right of
          // heading, -1 left) — corridor avoidance may switch sides (t_5a41d468).
          const camSide = sideTrackSideRef.current;
          const px = Cesium.SceneTransforms.worldToWindowCoordinates(
            viewer.scene,
            Cesium.Cartesian3.fromDegrees(riderLon, riderLat, groundEle + 1),
          );
          // Rider head (~1.7 m): with riderScreen gives the rider's on-screen height.
          const head = Cesium.SceneTransforms.worldToWindowCoordinates(
            viewer.scene,
            Cesium.Cartesian3.fromDegrees(riderLon, riderLat, groundEle + 1.7),
          );
          const foot = Cesium.SceneTransforms.worldToWindowCoordinates(
            viewer.scene,
            Cesium.Cartesian3.fromDegrees(riderLon, riderLat, groundEle),
          );
          // Screen points in the view's own CSS px: the canvas of a cropped
          // view (floating window, hudLensCrop) starts this far above it.
          const cropTop = lensCropRef.current?.extendPx ?? 0;
          return {
            routeEle: sampled.ele,
            groundEle,
            cameraHeight: viewer.camera.positionCartographic.height,
            camSide,
            // Side / orbit camera sight (lib/sideCamSight): side, eased offset
            // fraction, whether a clear spot was found, cuts and tile reads.
            sideCam: sideCamSightRef.current.debug(),
            sideCamTileReads: meshTopReadStats(),
            dist: state.distance,
            riderLonLat: [riderLon, riderLat],
            startGround: startGroundRef.current?.debug() ?? null,
            globeShown: viewer.scene.globe.show,
            meshGround: avatarRef.current?.meshGround() ?? false,
            riderScreen: px ? [Math.round(px.x), Math.round(px.y - cropTop)] : null,
            riderHeightPx: head && foot ? Math.round(Math.hypot(head.x - foot.x, head.y - foot.y)) : null,
            viewportPx: [viewer.canvas.clientWidth, viewer.canvas.clientHeight - cropTop],
            lensShiftPx: cropTop / 2,
          };
        };
      }

      // ---- Camera: per-mode positioning + cross-mode transition ----
      if (shouldChaseCamUpdate(state.rideState)) {
        // Show mode hands the camera to the auto director unless the rider
        // picked a camera themselves.
        const currentMode = effectiveCameraMode(
          useSettingsStore.getState().cameraMode,
          useShowStore.getState(),
          { routeId: r.id, distance: state.distance, speed: state.speed, steer: activeSteer() },
          nowMs,
        );
        const riderPose = {
          lat: sampled.lat,
          lon: sampled.lon,
          ele: groundEle,
          heading,
          cadence: state.cadence,
          speed: state.speed,
        };

        // Detect mode change — start a transition from the last known pose.
        if (currentMode !== lastCamModeRef.current) {
          if (lastCamPoseRef.current) {
            camTransitionRef.current = {
              fromPose: lastCamPoseRef.current,
              startMs: nowMs,
            };
          }
          // Chase keeps its own eased state; start it from where the camera
          // is now so the cut back glides instead of jumping.
          if (currentMode === 'chase') {
            seedFollowCam(viewer.camera.positionWC, viewer.camera.heading, viewer.camera.pitch);
          }
          lastCamModeRef.current = currentMode;
          sideCamSightRef.current.reset();
        }

        // Compute the live target pose for the current mode.
        const cameraDistance = useSettingsStore.getState().cameraDistance;
        // Side-tracking keeps out of the ground-clamped road corridor volume:
        // on curves the perpendicular offset can land inside it (full-frame
        // grey faceted render), so pass the route window and let the pose push
        // out or switch sides. The ref carries the last side (hysteresis).
        // The corridor is only there while the painted road is drawn (where
        // the globe is the ground); over the mesh nothing needs keeping out of.
        const roadPainted = globeShown && roadEntityRef.current !== null;
        let corridor: SideTrackCorridor | undefined;
        if (currentMode === 'sideTracking') {
          corridor = {
            points: roadPainted ? r.points : [],
            riderDistanceM: pose.distance,
            preferredSide: sideTrackSideRef.current,
          };
        }
        let targetPose = computeCameraPose(currentMode, riderPose, nowMs, cameraDistance, corridor);
        // Side / orbit shots stand 3-4 m up beside the road, where the
        // hillside, house fronts and palms are. Over the mesh the camera moves
        // in to where it sees the rider over what is drawn, or crosses the
        // road to an open side; lifting it over the top of whatever is drawn
        // put it on roofs (renderers/cesium/sideCam, t_1ec01b75).
        targetPose = placeSideCam({
          scene: viewer.scene,
          sight: sideCamSightRef.current,
          mode: currentMode,
          pose: targetPose,
          heading,
          lon: sampled.lon,
          lat: sampled.lat,
          routeEle: sampled.ele,
          groundEle,
          speed: state.speed,
          distanceM: pose.distance,
          nowMs,
          dt,
          roadPainted,
        });
        if (corridor) {
          sideTrackSideRef.current = sideTrackSideFromPose(targetPose, heading);
        }

        // Determine the effective pose (transitioning or live).
        let effectivePose: CameraPose;
        const transition = camTransitionRef.current;
        if (transition) {
          const elapsed = nowMs - transition.startMs;
          const t = Math.min(elapsed / CAM_TRANSITION_MS, 1);
          effectivePose = easedCameraTransition(transition.fromPose, targetPose, t);
          if (t >= 1) {
            camTransitionRef.current = null;
          }
        } else {
          effectivePose = targetPose;
        }

        // Store for next frame's transition start.
        lastCamPoseRef.current = effectivePose;

        if (currentMode === 'chase') {
          // Delegate to the legacy eased follow-cam so it retains its own
          // internal lerp state (keeps the chase cam silky smooth).
          const framing = CHASE_FRAMING[cameraDistance] ?? CHASE_FRAMING.standard;
          applyFollowCam(
            viewer,
            { lat: sampled.lat, lon: sampled.lon, ele: groundEle },
            aheadAtGround,
            {
              backMeters: framing.backM,
              upMeters: framing.upM,
              pitchDeg: Cesium.Math.toDegrees(chasePitchRad(framing)),
              minClearanceMeters: CHASE_MIN_CLEARANCE_M,
            },
            dt,
          );
        } else {
          // Convert ENU offset to world Cartesian3 and apply.
          const riderCartesian = Cesium.Cartesian3.fromDegrees(
            sampled.lon,
            sampled.lat,
            groundEle,
          );
          const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(riderCartesian);
          const offsetLocal = new Cesium.Cartesian3(
            effectivePose.offsetENU.x,
            effectivePose.offsetENU.y,
            effectivePose.offsetENU.z,
          );
          const camPos = Cesium.Matrix4.multiplyByPoint(
            enuFrame,
            offsetLocal,
            new Cesium.Cartesian3(),
          );
          // Side / orbit shots sit low beside the road, where the hillside,
          // walls and trees are: keep them above whatever is rendered there.
          let appliedPitch = effectivePose.pitch;
          if (currentMode === 'sideTracking' || currentMode === 'cinematic') {
            liftAboveTerrain(viewer.scene, camPos, groundEle, CHASE_MIN_CLEARANCE_M);
            // Over the photoreal mesh only a (throttled) GPU sample sees the
            // buildings; the lift rises at once and settles back slowly.
            const camCarto = Cesium.Cartographic.fromCartesian(camPos);
            if (camCarto) {
              let camGround = cameraGroundSamplers.get(viewer.scene);
              if (!camGround) {
                camGround = createGroundSampler(viewer.scene);
                cameraGroundSamplers.set(viewer.scene, camGround);
              }
              const ground = camGround.sample(
                Cesium.Math.toDegrees(camCarto.longitude),
                Cesium.Math.toDegrees(camCarto.latitude),
                sampled.ele,
                nowMs,
              );
              // A cut across the road leaves the old side's lift behind: at
              // Santa Monica 1.5 km a 7 m lift over palm crowns, carried over,
              // filmed the far side's crowns from above.
              const cuts = sideCamSightRef.current.cuts();
              if (cuts !== sideCamCutsRef.current) {
                sideCamCutsRef.current = cuts;
                cameraLiftRef.current = 0;
              }
              const needed =
                ground === undefined || (ground > camCarto.height && sideCamSightRef.current.castClear())
                  ? 0
                  : Math.max(0, ground + CHASE_MIN_CLEARANCE_M - camCarto.height);
              // A top over the camera while the sight's casts see the rider
              // with air under the camera is a canopy it stands under: lifted
              // over it, it filmed palm crowns from above (Santa Monica
              // 1555 m, t_ee2165b8). Only a top under the camera lifts it.
              const lift = Math.max(needed, cameraLiftRef.current * Math.exp(-1.5 * Math.min(dt, 0.1)));
              cameraLiftRef.current = lift;
              if (lift > 0.01) {
                camCarto.height += lift;
                Cesium.Cartographic.toCartesian(camCarto, undefined, camPos);
              }
              // Re-aim at the rider from the camera's ACTUAL height. The pose
              // pitch assumes the nominal 3–4 m; without this a lifted camera
              // looks straight past the rider — the rider leaves the frame and
              // the view ends up in roadside mesh at roof height (t_5a41d468).
              // At nominal height this is a no-op (same formula as the pose).
              const horizM = Math.hypot(effectivePose.offsetENU.x, effectivePose.offsetENU.y);
              if (horizM > 0.01) {
                appliedPitch = riderAimPitchRad(camCarto.height - groundEle, horizM);
              }
            }
          } else {
            cameraLiftRef.current = 0;
          }
          viewer.camera.setView({
            destination: camPos,
            orientation: {
              heading: effectivePose.heading,
              pitch: appliedPitch,
              roll: effectivePose.roll,
            },
          });
        }
      }

      // Spectator crowds — fade based on rider proximity.
      if (
        spectatorCollectionRef.current &&
        spectatorDistancesRef.current.length > 0
      ) {
        updateSpectatorVisibility(
          spectatorCollectionRef.current,
          state.distance,
          spectatorDistancesRef.current,
          200,   // fade-in over 200 m
          1000,  // show within 1 km
        );
      }

      // ---- Weather particle system update ----
      // Reposition spawn volume above the rider each frame. Zero allocations.
      weatherSystemRef.current?.update({
        lat: sampled.lat,
        lon: sampled.lon,
        ele: groundEle,
        heading,
      });

      // Cloud parallax — drift clouds with a light 5 m/s westerly wind.
      // The constant wind values keep this zero-allocation: no objects created.
      if (cloudCollectionRef.current) {
        updateCloudParallax(cloudCollectionRef.current, 5, 270, dt * 1000);
      }
      // Dynamic ground shadow — sized and rotated by real sun angle. The
      // sun moves ~0.25°/min, so recomputing its position more often than
      // every few seconds is wasted trig + allocation on a per-frame budget.
      if (shadowHandleRef.current) {
        let sun = sunCacheRef.current;
        if (!sun || nowMs - sun.t >= SUN_CACHE_MS) {
          const sunPos = sunAzimuthAndAltitude(new Date(), sampled.lat, sampled.lon);
          sun = { t: nowMs, azimuth: sunPos.azimuth, altitude: sunPos.altitude };
          sunCacheRef.current = sun;
        }
        updateShadowEntity(
          shadowHandleRef.current,
          { lat: sampled.lat, lon: sampled.lon, ele: groundEle, grade: state.grade, heading },
          sun.azimuth,
          sun.altitude,
        );
      }

      // ---- Pace bot avatar updates ----
      // Each partner in its lateral slot beside the line (botAvatars). A
      // count mismatch can occur if bots are added after route load — the
      // update skips silently rather than crash; the user would need to
      // re-select the route.
      if (r) updateBotAvatars(useRideStore.getState().paceBots, botAvatarsRef.current, dt);

      // ---- Ghost avatar updates ----
      const ghostsOn = useGhostStore.getState().ghostsEnabled;
      const ghostAvatars = ghostAvatarsRef.current;
      const ghostRides = ghostRidesRef.current;
      if (ghostsOn && ghostAvatars.length > 0 && r) {
        // Ghost time is driven by the live rider's elapsed wall-clock seconds.
        const elapsedSec = state.elapsedMs / 1000;
        for (let i = 0; i < ghostAvatars.length; i++) {
          const ghostDist = ghostRides[i].distanceAt(elapsedSec);
          // null means ghost hasn't started yet — hide it.
          if (ghostDist === null) {
            ghostAvatars[i].setShow(false);
            continue;
          }
          const clampedDist = Math.max(0, Math.min(r.totalDistance, ghostDist));
          const gPos = sampleRouteAtDistance(r, clampedDist);
          const gHeading = headingAt(r, clampedDist);
          // Estimate a plausible speed from distance delta / dt for animation.
          const prevDist = ghostRides[i].distanceAt(Math.max(0, elapsedSec - dt));
          const ghostSpeed = prevDist !== null ? Math.abs(clampedDist - prevDist) / (dt || 1 / 60) : 0;
          ghostAvatars[i].setShow(true);
          ghostAvatars[i].update({
            lon: gPos.lon,
            lat: gPos.lat,
            ele: gPos.ele,
            heading: gHeading,
            speed: ghostSpeed,
            cadence: 0, // avatar estimates from speed
            grade: state.grade,
            dt,
            riderPosition: 'hoods',
          });
        }
      }
    };

    viewer.scene.preRender.addEventListener(handler);
    removeTickRef.current = () => {
      if (!viewer.isDestroyed()) viewer.scene.preRender.removeEventListener(handler);
    };
    return () => {
      // The bootstrap effect's cleanup may have already destroyed the viewer
      // (React StrictMode remount, or navigating away from the ride). Touching
      // viewer.scene after destroy throws — guard it.
      if (!viewer.isDestroyed()) viewer.scene.preRender.removeEventListener(handler);
      removeTickRef.current = null;
    };
    // viewerReady is in the dep array because the viewer is created async
    // (same root cause as the route-loading effect — the `if (!viewer) return`
    // guard at the top bails on first mount before Cesium has finished
    // initializing, and without viewerReady the handler is never registered).
    // Without this, applyFollowCam never runs and the camera stays at the
    // initial flyToBoundingSphere altitude (~7 km up, pitched -35°).
  }, [viewerReady]);

  // ---- Outdoor GPS live polyline ----
  // Update the live track entity each time the GPS polyline array grows.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    if (rideMode !== 'outdoor') {
      // Remove stale live polyline entity when switching away from outdoor mode.
      if (livePolylineEntityRef.current) {
        viewer.entities.remove(livePolylineEntityRef.current);
        livePolylineEntityRef.current = null;
      }
      return;
    }
    if (livePolyline.length < 2) return;

    const positions = livePolyline.map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, sceneEle(p.ele)),
    );

    if (!livePolylineEntityRef.current) {
      // Create entity on first GPS fix.
      livePolylineEntityRef.current = viewer.entities.add({
        name: 'outdoor-live-track',
        polyline: {
          positions: new Cesium.ConstantProperty(positions),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.2,
            color: Cesium.Color.fromCssColorString('#22c55e'),
          }),
          clampToGround: true,
        },
      });
    } else {
      // Update positions in-place.
      if (livePolylineEntityRef.current.polyline) {
        livePolylineEntityRef.current.polyline.positions = new Cesium.ConstantProperty(positions);
      }
    }
  }, [livePolyline, rideMode]);

  // ---- Outdoor camera: follow live GPS position ----
  // When in outdoor mode the avatar follow-cam reads positionNow from the
  // store (set by useRideLoop from the GPS sample), so the existing preRender
  // handler already drives the camera correctly via rideStore.distance.
  // No additional effect needed — the per-frame handler in the preRender
  // block uses rideStore.distance which useRideLoop advances from GPS speed.

  return (
    <>
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />
      {/* Multi-rider peer avatars — rendered into the Cesium viewer once it is ready. */}
      {viewerReady && viewerRef.current && !viewerRef.current.isDestroyed() && (
        <MultiRiderPeers viewer={viewerRef.current} />
      )}
    </>
  );
}
