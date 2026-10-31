import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';

import { worldForRoute } from '@/lib/world/catalog';
import type { RendererKind, WorldRenderer } from '@/lib/world/renderer';
import { RENDERER_LOADERS, rendererFor, type WorldViewComponent } from '@/renderers/registry';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';

// One lazy component per renderer, created on first use so a renderer's
// chunk (and its engine) is fetched only when it is the one that draws.
const lazyViews = new Map<RendererKind, LazyExoticComponent<WorldViewComponent>>();

function viewFor(kind: RendererKind): LazyExoticComponent<WorldViewComponent> | null {
  const load = RENDERER_LOADERS[kind];
  if (!load) return null;
  let view = lazyViews.get(kind);
  if (!view) {
    view = lazy(() => load().then((component) => ({ default: component })));
    lazyViews.set(kind, view);
  }
  return view;
}

/**
 * The world behind the ride HUD. Picks the renderer from settings
 * (`renderer`, default 'world'; see renderers/registry for what this build
 * ships), mounts it full-bleed, and hands its WorldRenderer to the ride view
 * once the first frame is up.
 *
 * The world renderer draws only routes inside a baked world bundle
 * (lib/world/catalog); other routes, outdoor GPS rides, and a world that
 * fails to load ride on 'photoreal' instead.
 */
export function RideView({
  ionToken,
  onRendererReady,
  fallback,
}: {
  ionToken: string | null;
  /** The live renderer, or null when it goes away (renderer switch / unmount). */
  onRendererReady?: (renderer: WorldRenderer | null) => void;
  /** Shown while the renderer's chunk loads (default: the plain background). */
  fallback?: ReactNode;
}) {
  const preferred = useSettingsStore((s) => s.renderer);
  const route = useRideStore((s) => s.route);
  const rideMode = useRideStore((s) => s.rideMode);
  const world = useMemo(() => (rideMode === 'outdoor' ? null : worldForRoute(route)), [route, rideMode]);
  // A world that could not draw this session (load error, no WebGL2).
  const [failedWorld, setFailedWorld] = useState<string | null>(null);
  const canWorld = world !== null && failedWorld !== world.id;
  const kind = rendererFor(preferred, canWorld);
  const View = viewFor(kind);
  const worldId = kind === 'world' ? (world?.id ?? null) : null;

  const rendererRef = useRef<WorldRenderer | null>(null);
  const onReadyRef = useRef(onRendererReady);
  onReadyRef.current = onRendererReady;

  const handleReady = useCallback((renderer: WorldRenderer) => {
    rendererRef.current = renderer;
    onReadyRef.current?.(renderer);
  }, []);

  const handleUnavailable = useCallback(
    (reason: string) => {
      if (!worldId) return;
      console.warn(`[velo] world renderer unavailable, riding photoreal: ${reason}`);
      setFailedWorld(worldId);
    },
    [worldId],
  );

  // Dispose the old renderer when the kind changes or the ride view leaves.
  useEffect(
    () => () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      onReadyRef.current?.(null);
    },
    [kind],
  );

  return (
    <div
      className="contents"
      data-renderer={kind}
      data-renderer-preferred={preferred}
      data-world={worldId ?? ''}
    >
      {View && (
        <Suspense
          fallback={fallback ?? <div className="absolute inset-0 bg-background" aria-hidden="true" />}
        >
          <View key={kind} ionToken={ionToken} onReady={handleReady} onUnavailable={handleUnavailable} />
        </Suspense>
      )}
    </div>
  );
}
