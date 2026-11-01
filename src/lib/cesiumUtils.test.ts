/**
 * cesiumUtils.test.ts — unit coverage for the token-aware Cesium helpers.
 *
 * Three concerns:
 *   1. `setupBaseImagery` chooses the right provider per branch:
 *        - with token: Bing Aerial (ion asset 2) — never asset 3812.
 *        - without token: OpenStreetMap raster tiles via the public CDN.
 *   2. `getTerrainProvider` degrades gracefully:
 *        - with token: Cesium World Terrain (createWorldTerrainAsync).
 *        - without token: flat EllipsoidTerrainProvider, no network call.
 *   3. The Bing tile-stall watchdog (BING_TILE_STALL_TIMEOUT_MS) auto-
 *      degrades the photoreal layer to OSM when tiles silently never paint —
 *      the highest-impact production resilience knob in this module.
 *
 * Cesium is mocked so we can assert which constructors were invoked without
 * needing a WebGL context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock Cesium surface — just the constructors / static methods touched by
// the helpers under test.
//
// vi.mock factories are hoisted, so they can't close over module-level
// variables. We use vi.hoisted to declare the shared state in the same
// hoisted phase as the mock factory itself.
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  ionAssetIdCalls: [] as number[],
  osmConstructorCalls: [] as Array<{ url?: string; maximumLevel?: number }>,
  ellipsoidTerrainConstructorCalls: [] as unknown[],
  worldTerrainCalls: [] as number[],
  imageryLayerInstances: [] as Array<{ __osm?: boolean; __ion?: boolean }>,
  ionAccessor: { defaultAccessToken: '' },
}));

vi.mock('cesium', () => ({
  IonImageryProvider: {
    fromAssetId: vi.fn(async (assetId: number) => {
      mockState.ionAssetIdCalls.push(assetId);
      return { __ionProvider: true, assetId };
    }),
  },
  // Track the most recent provider passed in so tests can distinguish the
  // Bing layer from the later OSM swap-in.
  ImageryLayer: vi.fn(function IL(
    this: unknown,
    provider: { __osm?: boolean; __ionProvider?: boolean } | undefined,
  ) {
    const instance = this as { __osm?: boolean; __ion?: boolean; imageryProvider?: unknown };
    instance.imageryProvider = provider;
    if (provider && '__osm' in provider) instance.__osm = true;
    if (provider && '__ionProvider' in provider) instance.__ion = true;
    mockState.imageryLayerInstances.push(instance);
  }),
  OpenStreetMapImageryProvider: vi.fn(function OSMP(this: unknown, opts: { url?: string; maximumLevel?: number }) {
    mockState.osmConstructorCalls.push(opts);
    Object.assign(this as object, { __osm: true });
  }),
  EllipsoidTerrainProvider: vi.fn(function ETP(this: unknown) {
    mockState.ellipsoidTerrainConstructorCalls.push({});
    Object.assign(this as object, { __ellipsoid: true });
  }),
  createWorldTerrainAsync: vi.fn(async () => {
    mockState.worldTerrainCalls.push(Date.now());
    return { __worldTerrain: true };
  }),
  Credit: vi.fn(function C(this: unknown, text: string) {
    Object.assign(this as object, { text });
  }),
  Cesium3DTileset: {
    fromIonAssetId: vi.fn(async (assetId: number) => ({ __tileset: true, assetId })),
  },
  Ion: mockState.ionAccessor,
  Cartographic: { fromDegrees: (lon: number, lat: number) => ({ lon, lat }) },
  NearFarScalar: vi.fn(function NFS(
    this: unknown,
    near: number,
    nearValue: number,
    far: number,
    farValue: number,
  ) {
    Object.assign(this as object, { near, nearValue, far, farValue });
  }),
}));

// Local aliases for readability in test bodies.
const ionAssetIdCalls = mockState.ionAssetIdCalls;
const osmConstructorCalls = mockState.osmConstructorCalls;
const ellipsoidTerrainConstructorCalls = mockState.ellipsoidTerrainConstructorCalls;
const worldTerrainCalls = mockState.worldTerrainCalls;
const imageryLayerInstances = mockState.imageryLayerInstances;
const ionAccessor = mockState.ionAccessor;

// ---------------------------------------------------------------------------
// Import after the mock is registered.
// ---------------------------------------------------------------------------

import {
  setupBaseImagery,
  setIonToken,
  hasIonToken,
  sceneEle,
  onSceneSurface,
  sceneGroundHeight,
  fallbackSceneEle,
  getTerrainProvider,
  getPhotorealTileset,
  setupGlobeVeilTranslucency,
  applyGlobeVeilTranslucency,
  GLOBE_VEIL_ALPHA_NEAR_M,
  GLOBE_VEIL_ALPHA_FAR_M,
  BING_TILE_STALL_TIMEOUT_MS,
  IMAGERY_FALLBACK_EVENT,
} from '@/lib/cesiumUtils';

/**
 * Minimal `Cesium.Event`-shaped stub. The watchdog calls
 * `addEventListener(fn)` and stores the returned remover; tests trigger
 * progress by calling `.raise()` directly.
 */
interface FakeProgressEvent {
  addEventListener: ReturnType<typeof vi.fn>;
  raise: () => void;
  removeAll: () => void;
  listeners: Array<() => void>;
}

function makeProgressEvent(): FakeProgressEvent {
  const listeners: Array<() => void> = [];
  const addEventListener = vi.fn((fn: () => void) => {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  return {
    addEventListener,
    raise: () => {
      // copy to avoid mutation during iteration when a listener self-removes
      [...listeners].forEach((fn) => fn());
    },
    removeAll: () => {
      listeners.length = 0;
    },
    listeners,
  };
}

interface FakeViewer {
  isDestroyed: ReturnType<typeof vi.fn>;
  scene: {
    imageryLayers: {
      add: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
    globe: {
      tilesLoaded: boolean;
      tileLoadProgressEvent: FakeProgressEvent;
    };
  };
}

// Each test creates a fresh fake viewer object so the WeakSet-based
// idempotency guard inside setupBaseImagery never sees the same key twice.
//
// The viewer now exposes scene.globe with a tile-progress event so the
// watchdog can subscribe; tests drive the event directly via `.raise()`.

function makeViewer(): FakeViewer & import('cesium').Viewer {
  const viewer: FakeViewer = {
    isDestroyed: vi.fn(() => false),
    scene: {
      imageryLayers: {
        add: vi.fn(),
        remove: vi.fn(),
      },
      globe: {
        tilesLoaded: false,
        tileLoadProgressEvent: makeProgressEvent(),
      },
    },
  };
  return viewer as FakeViewer & import('cesium').Viewer;
}

describe('cesiumUtils — token-aware behaviour', () => {
  beforeEach(() => {
    // Force-clear the installed flag and invalidate the cached terrain
    // promise BEFORE we zero the counters so the bookkeeping done during
    // reset doesn't pollute the per-test call counts.
    setIonToken(null);
    void getTerrainProvider(true).catch(() => undefined);
    // Now drop all counters so each test sees a clean slate.
    ionAssetIdCalls.length = 0;
    osmConstructorCalls.length = 0;
    ellipsoidTerrainConstructorCalls.length = 0;
    worldTerrainCalls.length = 0;
    imageryLayerInstances.length = 0;
    ionAccessor.defaultAccessToken = '';
  });

  // -------------------------------------------------------------------------
  // setupBaseImagery — no-token branch
  // -------------------------------------------------------------------------

  describe('setupBaseImagery — without ion token', () => {
    it('uses OSM imagery and never calls ion when no token is installed', async () => {
      const viewer = makeViewer();
      await setupBaseImagery(viewer);

      expect(osmConstructorCalls.length).toBe(1);
      expect(ionAssetIdCalls).toEqual([]);
    });

    it('configures OSM with the public tile.openstreetmap.org endpoint', async () => {
      const viewer = makeViewer();
      await setupBaseImagery(viewer);

      expect(osmConstructorCalls[0].url).toBe('https://tile.openstreetmap.org/');
    });

    it('adds the OSM imagery layer to the viewer scene', async () => {
      const viewer = makeViewer();
      await setupBaseImagery(viewer);

      const addSpy = viewer.scene.imageryLayers.add as ReturnType<typeof vi.fn>;
      expect(addSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // setupBaseImagery — with-token branch
  // -------------------------------------------------------------------------

  describe('setupBaseImagery — with ion token', () => {
    it('requests Bing Aerial (asset 2) when a token is installed', async () => {
      setIonToken('eyJ_a_realistic_looking_jwt_payload_here.signature');
      const viewer = makeViewer();
      await setupBaseImagery(viewer);

      expect(ionAssetIdCalls).toEqual([2]);
      expect(osmConstructorCalls.length).toBe(0);
    });

    it('falls back to OSM when ion Bing fetch rejects', async () => {
      const { IonImageryProvider } = await import('cesium');
      vi.mocked(IonImageryProvider.fromAssetId).mockRejectedValueOnce(
        new Error('401 Unauthorized'),
      );

      setIonToken('eyJ_a_realistic_looking_jwt_payload_here.signature');
      const viewer = makeViewer();
      await setupBaseImagery(viewer);

      // Bing was tried first, then OSM was used as the fallback so the
      // globe is never black.
      expect(osmConstructorCalls.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getTerrainProvider — both branches
  // -------------------------------------------------------------------------

  describe('getTerrainProvider', () => {
    it('returns a flat EllipsoidTerrainProvider when no token is installed', async () => {
      void getTerrainProvider(true).catch(() => undefined);
      const terrain = await getTerrainProvider();

      expect(ellipsoidTerrainConstructorCalls.length).toBe(1);
      expect(worldTerrainCalls.length).toBe(0);
      expect((terrain as { __ellipsoid?: boolean }).__ellipsoid).toBe(true);
    });

    it('returns Cesium World Terrain when a token is installed', async () => {
      setIonToken('eyJ_a_realistic_looking_jwt_payload_here.signature');
      void getTerrainProvider(true).catch(() => undefined);
      const terrain = await getTerrainProvider();

      expect(worldTerrainCalls.length).toBe(1);
      expect(ellipsoidTerrainConstructorCalls.length).toBe(0);
      expect((terrain as { __worldTerrain?: boolean }).__worldTerrain).toBe(true);
    });

    it('caches the result across calls within a single token state', async () => {
      void getTerrainProvider(true).catch(() => undefined);
      const a = await getTerrainProvider();
      const b = await getTerrainProvider();
      expect(a).toBe(b);
      // EllipsoidTerrainProvider should only have been constructed once.
      expect(ellipsoidTerrainConstructorCalls.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // hasIonToken / setIonToken
  // -------------------------------------------------------------------------

  describe('setIonToken / hasIonToken', () => {
    it('reports no token by default', () => {
      expect(hasIonToken()).toBe(false);
    });

    it('reports token after setIonToken with a non-empty string', () => {
      setIonToken('eyJ_some_token_value_here.signature');
      expect(hasIonToken()).toBe(true);
    });

    it('reports no token after setIonToken(null) — clears Cesium default', () => {
      setIonToken('eyJ_x.y');
      setIonToken(null);
      expect(hasIonToken()).toBe(false);
      expect(ionAccessor.defaultAccessToken).toBe('');
    });

    it('treats whitespace-only tokens as no token', () => {
      setIonToken('   ');
      expect(hasIonToken()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // sceneEle / onSceneSurface — rider, camera and route lines sit on the
  // rendered surface: GPX height on ion terrain, 0 m on the flat globe.
  // -------------------------------------------------------------------------

  describe('sceneEle / onSceneSurface', () => {
    it('puts everything at 0 m on the flat no-token globe', () => {
      setIonToken(null);
      expect(sceneEle(281.4)).toBe(0);
      const p = { lat: 46, lon: 8.95, ele: 281.4, distance: 12 };
      expect(onSceneSurface(p)).toEqual({ lat: 46, lon: 8.95, ele: 0, distance: 12 });
      expect(p.ele).toBe(281.4); // the route itself is untouched
    });

    it('drops to 0 m when ion refuses the token (World Terrain 401)', async () => {
      setIonToken('eyJ_rejected');
      const mocked = vi.mocked(
        (await import('cesium')).createWorldTerrainAsync as unknown as () => Promise<unknown>,
      );
      mocked.mockRejectedValueOnce(new Error('401 INVALID_TOKEN'));
      await getTerrainProvider(true).catch(() => undefined);
      expect(sceneEle(281.4)).toBe(0);
      // A later success (fixed token) brings the real elevation back.
      await getTerrainProvider(true);
      expect(sceneEle(281.4)).toBe(281.4);
      setIonToken(null);
    });

    it('keeps the GPX elevation when ion terrain is in use', () => {
      setIonToken('eyJ_so...ture');
      expect(sceneEle(281.4)).toBe(281.4);
      const p = { lat: 46, lon: 8.95, ele: 281.4 };
      expect(onSceneSurface(p)).toBe(p);
      setIonToken(null);
    });
  });

  // -------------------------------------------------------------------------
  // Scene ground for rider + camera — never the route height over a void
  // -------------------------------------------------------------------------

  describe('sceneGroundHeight / fallbackSceneEle (slow phone: terrain still streaming)', () => {
    async function ellipsoid() {
      const C = await import('cesium');
      return new (C.EllipsoidTerrainProvider as unknown as new () => object)();
    }
    function fakeScene(o: { sample?: number; globe?: number; terrain?: object; supported?: boolean }) {
      return {
        sampleHeightSupported: o.supported ?? true,
        sampleHeight: vi.fn(() => o.sample),
        globe: { getHeight: vi.fn(() => o.globe) },
        terrainProvider: o.terrain,
      } as unknown as import('cesium').Scene;
    }

    it('token, World Terrain not assigned yet: rider and camera sit on the 0 m ellipsoid, not at route height', async () => {
      setIonToken('eyJ_valid');
      const scene = fakeScene({ sample: undefined, globe: 0, terrain: await ellipsoid() });
      expect(sceneGroundHeight(scene, 8.95, 46) ?? fallbackSceneEle(scene, 281.4)).toBe(0);
      // Nothing rendered at all yet: still the ellipsoid, not 281 m of void.
      const empty = fakeScene({ sample: undefined, globe: undefined, terrain: await ellipsoid() });
      expect(sceneGroundHeight(empty, 8.95, 46) ?? fallbackSceneEle(empty, 281.4)).toBe(0);
      // Level-0 tile chord (measured -12 155 m on a throttled phone) is ignored: flat = 0 m.
      const coarse = fakeScene({ sample: undefined, globe: -12155, terrain: await ellipsoid() });
      expect(sceneGroundHeight(coarse, 8.95, 46, undefined, 281.4)).toBe(0);
      setIonToken(null);
    });

    it('token, World Terrain streaming: uses the coarse loaded tiles right away', () => {
      setIonToken('eyJ_valid');
      const scene = fakeScene({ sample: undefined, globe: 240, terrain: { __worldTerrain: true } });
      expect(sceneGroundHeight(scene, 8.95, 46)).toBe(240);
      setIonToken(null);
    });

    it('token, coarse World Terrain tile far below the route: not trusted, route height instead', () => {
      setIonToken('eyJ_valid');
      const scene = fakeScene({ sample: undefined, globe: -12155, terrain: { __worldTerrain: true } });
      expect(sceneGroundHeight(scene, 8.95, 46, undefined, 281.4)).toBeUndefined();
      // Same for a surface sample that hits the coarse chord.
      const sampledLow = fakeScene({ sample: -2400, globe: -12155, terrain: { __worldTerrain: true } });
      expect(sceneGroundHeight(sampledLow, 8.95, 46, undefined, 281.4)).toBeUndefined();
      expect(fallbackSceneEle(scene, 281.4)).toBe(281.4);
      setIonToken(null);
    });

    it('token, tiles loaded: the precise surface sample wins', () => {
      setIonToken('eyJ_valid');
      const scene = fakeScene({ sample: 279.6, globe: 240, terrain: { __worldTerrain: true } });
      expect(sceneGroundHeight(scene, 8.95, 46)).toBe(279.6);
      setIonToken(null);
    });

    it('token, World Terrain assigned but no tile yet: route height (terrain will match it)', () => {
      setIonToken('eyJ_valid');
      const scene = fakeScene({ sample: undefined, globe: undefined, terrain: { __worldTerrain: true } });
      expect(sceneGroundHeight(scene, 8.95, 46)).toBeUndefined();
      expect(fallbackSceneEle(scene, 281.4)).toBe(281.4);
      setIonToken(null);
    });

    it('no token: never samples the mesh, flat globe is 0 m', async () => {
      setIonToken(null);
      const scene = fakeScene({ sample: 999, globe: 0, terrain: await ellipsoid() });
      expect(sceneGroundHeight(scene, 8.95, 46)).toBe(0);
      expect((scene as unknown as { sampleHeight: ReturnType<typeof vi.fn> }).sampleHeight).not.toHaveBeenCalled();
      expect(fallbackSceneEle(scene, 281.4)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getPhotorealTileset — guards against ion calls without a token
  // -------------------------------------------------------------------------

  describe('getPhotorealTileset', () => {
    it('rejects without making an ion network call when no token is installed', async () => {
      await expect(getPhotorealTileset()).rejects.toThrow(/Cesium ion token/);

      const { Cesium3DTileset } = await import('cesium');
      expect(Cesium3DTileset.fromIonAssetId).not.toHaveBeenCalled();
    });

    it('forwards to Cesium3DTileset.fromIonAssetId when a token is installed', async () => {
      setIonToken('eyJ_x.y');
      const tileset = await getPhotorealTileset();
      expect((tileset as { assetId?: number }).assetId).toBe(2275207);
    });
  });

  // -------------------------------------------------------------------------
  // Legacy invariants from the original test file — still hold
  // -------------------------------------------------------------------------

  describe('setupBaseImagery — legacy invariants', () => {
    it('never requests asset 3812 (removed entitlement-gated Bing variant)', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer();
      await setupBaseImagery(viewer);
      expect(ionAssetIdCalls).not.toContain(3812);
    });

    it('is idempotent — second call for the same viewer is a no-op', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer();
      await setupBaseImagery(viewer);
      await setupBaseImagery(viewer);

      const addSpy = viewer.scene.imageryLayers.add as ReturnType<typeof vi.fn>;
      expect(addSpy).toHaveBeenCalledTimes(1);
    });

    it('does not throw when ion asset 2 is unavailable and OSM fallback succeeds', async () => {
      const { IonImageryProvider } = await import('cesium');
      vi.mocked(IonImageryProvider.fromAssetId).mockRejectedValueOnce(
        new Error('404 Not Found'),
      );

      setIonToken('eyJ_x.y');
      const viewer = makeViewer();
      await expect(setupBaseImagery(viewer)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Bing tile-stall watchdog — auto OSM fallback after BING_TILE_STALL_TIMEOUT_MS
  // -------------------------------------------------------------------------

  describe('setupBaseImagery — Bing tile-stall watchdog', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
      warnSpy.mockRestore();
    });

    it('does NOT subscribe to tileLoadProgressEvent (event fires on queue-length changes, not actual loads)', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      // The watchdog deliberately doesn't listen to progress — see the
      // comment in armBingTileStallWatchdog for the prod-observed reason.
      expect(viewer.scene.globe.tileLoadProgressEvent.addEventListener).not.toHaveBeenCalled();
    });

    it('does NOT swap to OSM when globe.tilesLoaded becomes true before the deadline', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      // A healthy network finishes loading before the deadline.
      viewer.scene.globe.tilesLoaded = true;

      // Blow well past the deadline — fallback must NOT fire because tiles
      // are loaded.
      vi.advanceTimersByTime(BING_TILE_STALL_TIMEOUT_MS * 2);

      expect(osmConstructorCalls.length).toBe(0);
      expect(viewer.scene.imageryLayers.remove).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('keeps Bing when at least one Bing tile arrived, even if the globe is still loading', async () => {
      const { IonImageryProvider } = await import('cesium');
      // Token rides: World Terrain tiles keep globe.tilesLoaded false for a
      // long time, while Bing is fine. That used to fall back + show the banner.
      vi.mocked(IonImageryProvider.fromAssetId).mockResolvedValueOnce({
        __ionProvider: true,
        requestImage: () => Promise.resolve({ width: 256 }),
      } as never);
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);
      const layer = imageryLayerInstances[0] as unknown as { imageryProvider: { requestImage: () => Promise<unknown> } };
      await layer.imageryProvider.requestImage();
      await Promise.resolve();
      vi.advanceTimersByTime(BING_TILE_STALL_TIMEOUT_MS * 2);
      expect(osmConstructorCalls.length).toBe(0);
      expect(viewer.scene.imageryLayers.remove).not.toHaveBeenCalled();
    });

    it('still falls back when Bing requests never deliver an image', async () => {
      const { IonImageryProvider } = await import('cesium');
      vi.mocked(IonImageryProvider.fromAssetId).mockResolvedValueOnce({
        __ionProvider: true,
        requestImage: () => new Promise(() => undefined),
      } as never);
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);
      const layer = imageryLayerInstances[0] as unknown as { imageryProvider: { requestImage: () => Promise<unknown> } };
      void layer.imageryProvider.requestImage();
      vi.advanceTimersByTime(BING_TILE_STALL_TIMEOUT_MS);
      await Promise.resolve();
      expect(osmConstructorCalls.length).toBe(1);
    });

    it('waits long enough for World Terrain to go first (deadline >= 10 s)', () => {
      expect(BING_TILE_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    });

    it('swaps the Bing layer for OSM after BING_TILE_STALL_TIMEOUT_MS of zero progress', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      // Snapshot the Bing layer (the only layer added so far).
      expect(imageryLayerInstances.length).toBe(1);
      const bingLayer = imageryLayerInstances[0];
      expect(bingLayer.__ion).toBe(true);
      expect(osmConstructorCalls.length).toBe(0);

      // Drive the clock to the deadline with no progress events.
      vi.advanceTimersByTime(BING_TILE_STALL_TIMEOUT_MS);
      await Promise.resolve(); // flush microtask queue after timer

      // OSM provider was built, a second layer was constructed, the
      // imageryLayers.remove was called with the original Bing layer.
      expect(osmConstructorCalls.length).toBe(1);
      expect(viewer.scene.imageryLayers.remove).toHaveBeenCalledTimes(1);
      expect(viewer.scene.imageryLayers.remove).toHaveBeenCalledWith(bingLayer, true);
      // A single console.warn at fallback time so users have a trail.
      expect(warnSpy).toHaveBeenCalledWith(
        '[cesiumUtils] Bing tiles stalled, falling back to OSM',
      );
    });

    it('dispatches IMAGERY_FALLBACK_EVENT on the window when fallback fires', async () => {
      // The test runner is in a Node environment — install a minimal
      // window with the event-target surface dispatchImageryFallback needs.
      const eventSpy = vi.fn();
      const fakeWindow = {
        addEventListener: vi.fn((_type: string, fn: () => void) => {
          // Capture the spy under the matching name so dispatchEvent can route to it.
          if (_type === IMAGERY_FALLBACK_EVENT) {
            (fakeWindow as unknown as { _listeners: Array<() => void> })._listeners.push(fn);
          }
        }),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn((evt: { type: string }) => {
          if (evt.type === IMAGERY_FALLBACK_EVENT) {
            (fakeWindow as unknown as { _listeners: Array<() => void> })._listeners.forEach(
              (fn) => fn(),
            );
          }
          return true;
        }),
        _listeners: [] as Array<() => void>,
      };
      vi.stubGlobal('window', fakeWindow);
      vi.stubGlobal(
        'CustomEvent',
        class FakeCustomEvent {
          type: string;
          constructor(type: string) { this.type = type; }
        },
      );

      try {
        // Re-register the listener via the stubbed window so the watchdog's
        // dispatchEvent routes back to us.
        (fakeWindow as { addEventListener: (t: string, fn: () => void) => void }).addEventListener(
          IMAGERY_FALLBACK_EVENT,
          eventSpy,
        );

        setIonToken('eyJ_x.y');
        const viewer = makeViewer() as unknown as FakeViewer;
        await setupBaseImagery(viewer as unknown as import('cesium').Viewer);
        vi.advanceTimersByTime(BING_TILE_STALL_TIMEOUT_MS);
        await Promise.resolve();

        expect(eventSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('does NOT fire fallback if tilesLoaded becomes true before the deadline', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      // Simulate Cesium having completed all tile loads silently — no
      // progress event observed, but tilesLoaded flipped true on its own
      // (rare but possible on a tiny visible area).
      viewer.scene.globe.tilesLoaded = true;
      vi.advanceTimersByTime(BING_TILE_STALL_TIMEOUT_MS);
      await Promise.resolve();

      // Watchdog re-checks tilesLoaded at the deadline and bails — no swap.
      expect(osmConstructorCalls.length).toBe(0);
      expect(viewer.scene.imageryLayers.remove).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('ignores tile-progress events fired AFTER the fallback already happened', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      // Force fallback by running out the clock.
      vi.advanceTimersByTime(BING_TILE_STALL_TIMEOUT_MS);
      await Promise.resolve();

      // Now Bing tiles "finally" arrive late. The post-fallback progress
      // must NOT trigger any additional layer add / remove activity.
      const osmCountBefore = osmConstructorCalls.length;
      const removeCountBefore = vi.mocked(viewer.scene.imageryLayers.remove).mock.calls.length;
      viewer.scene.globe.tileLoadProgressEvent.raise();
      viewer.scene.globe.tileLoadProgressEvent.raise();
      await Promise.resolve();

      expect(osmConstructorCalls.length).toBe(osmCountBefore);
      expect(vi.mocked(viewer.scene.imageryLayers.remove).mock.calls.length).toBe(
        removeCountBefore,
      );
    });

    it('removes its tile-progress listener after firing fallback (no double-add)', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      vi.advanceTimersByTime(BING_TILE_STALL_TIMEOUT_MS);
      await Promise.resolve();

      // The fake event tracks live listener count via the `listeners` array;
      // the watchdog should have detached itself in cleanup().
      expect(viewer.scene.globe.tileLoadProgressEvent.listeners.length).toBe(0);
    });

    it('removes its tile-progress listener after progress is observed (disarm-ok)', async () => {
      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      // One progress event before the deadline → watchdog disarms.
      viewer.scene.globe.tileLoadProgressEvent.raise();

      // Listener should be detached, so a subsequent raise() reaches nothing.
      expect(viewer.scene.globe.tileLoadProgressEvent.listeners.length).toBe(0);
    });

    it('does not subscribe / does not throw when the viewer has no globe (test stubs)', async () => {
      setIonToken('eyJ_x.y');
      // Build a viewer whose scene lacks `globe` — earlier-style stubs.
      const minimalViewer = {
        isDestroyed: vi.fn(() => false),
        scene: { imageryLayers: { add: vi.fn(), remove: vi.fn() } },
      } as unknown as import('cesium').Viewer;

      await expect(
        setupBaseImagery(minimalViewer),
      ).resolves.toBeUndefined();

      // Bing layer added, no listener subscription attempted.
      expect(ionAssetIdCalls).toEqual([2]);
    });

    it('does NOT arm the watchdog when ion asset 2 rejects (immediate OSM path)', async () => {
      const { IonImageryProvider } = await import('cesium');
      vi.mocked(IonImageryProvider.fromAssetId).mockRejectedValueOnce(
        new Error('401 Unauthorized'),
      );

      setIonToken('eyJ_x.y');
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      // The immediate-failure OSM path adds OSM directly — no Bing layer to
      // arm a watchdog around. Subscribing would be a bug.
      expect(viewer.scene.globe.tileLoadProgressEvent.addEventListener).not.toHaveBeenCalled();
      expect(osmConstructorCalls.length).toBe(1);
    });

    it('dispatches IMAGERY_FALLBACK_EVENT on the immediate-failure OSM path too', async () => {
      const { IonImageryProvider } = await import('cesium');
      vi.mocked(IonImageryProvider.fromAssetId).mockRejectedValueOnce(
        new Error('401 Unauthorized'),
      );

      const eventSpy = vi.fn();
      const fakeWindow = {
        addEventListener: vi.fn((_type: string, fn: () => void) => {
          if (_type === IMAGERY_FALLBACK_EVENT) {
            (fakeWindow as unknown as { _listeners: Array<() => void> })._listeners.push(fn);
          }
        }),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn((evt: { type: string }) => {
          if (evt.type === IMAGERY_FALLBACK_EVENT) {
            (fakeWindow as unknown as { _listeners: Array<() => void> })._listeners.forEach(
              (fn) => fn(),
            );
          }
          return true;
        }),
        _listeners: [] as Array<() => void>,
      };
      vi.stubGlobal('window', fakeWindow);
      vi.stubGlobal(
        'CustomEvent',
        class FakeCustomEvent {
          type: string;
          constructor(type: string) { this.type = type; }
        },
      );

      try {
        (fakeWindow as { addEventListener: (t: string, fn: () => void) => void }).addEventListener(
          IMAGERY_FALLBACK_EVENT,
          eventSpy,
        );

        setIonToken('eyJ_x.y');
        const viewer = makeViewer() as unknown as FakeViewer;
        await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

        expect(eventSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('does not arm the watchdog on the no-token path', async () => {
      // No setIonToken call — purely the OSM-first path.
      const viewer = makeViewer() as unknown as FakeViewer;
      await setupBaseImagery(viewer as unknown as import('cesium').Viewer);

      expect(viewer.scene.globe.tileLoadProgressEvent.addEventListener).not.toHaveBeenCalled();
      // And of course no Bing call was made either.
      expect(ionAssetIdCalls).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Grey-veil mitigation (card t_0bcacadb): globe front-face translucency ramp.
// ---------------------------------------------------------------------------

describe('globe veil translucency', () => {
  function makeScene() {
    return {
      globe: {
        translucency: {
          enabled: false,
          frontFaceAlphaByDistance: undefined as unknown,
        },
      },
    } as unknown as import('cesium').Scene;
  }

  it('setup installs the near/far alpha ramp (transparent near, opaque far)', () => {
    const scene = makeScene();
    setupGlobeVeilTranslucency(scene);
    const ramp = scene.globe.translucency.frontFaceAlphaByDistance as unknown as {
      near: number; nearValue: number; far: number; farValue: number;
    };
    expect(ramp).toBeDefined();
    expect(ramp.near).toBe(GLOBE_VEIL_ALPHA_NEAR_M);
    expect(ramp.nearValue).toBe(0);
    expect(ramp.far).toBe(GLOBE_VEIL_ALPHA_FAR_M);
    expect(ramp.farValue).toBe(1);
    // Setup alone must NOT flip translucency on.
    expect(scene.globe.translucency.enabled).toBe(false);
  });

  it('apply toggles enabled idempotently', () => {
    const scene = makeScene();
    setupGlobeVeilTranslucency(scene);
    applyGlobeVeilTranslucency(scene, true);
    expect(scene.globe.translucency.enabled).toBe(true);
    applyGlobeVeilTranslucency(scene, true); // no throw, stays on
    expect(scene.globe.translucency.enabled).toBe(true);
    applyGlobeVeilTranslucency(scene, false);
    expect(scene.globe.translucency.enabled).toBe(false);
  });
});
