import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';

import type { RendererKind, WorldRenderer } from '@/lib/world/renderer';
import { RENDERER_LOADERS, rendererFor, type WorldViewComponent } from '@/renderers/registry';
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
  const kind = rendererFor(preferred);
  const View = viewFor(kind);

  const rendererRef = useRef<WorldRenderer | null>(null);
  const onReadyRef = useRef(onRendererReady);
  onReadyRef.current = onRendererReady;

  const handleReady = useCallback((renderer: WorldRenderer) => {
    rendererRef.current = renderer;
    onReadyRef.current?.(renderer);
  }, []);

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
    <div className="contents" data-renderer={kind} data-renderer-preferred={preferred}>
      {View && (
        <Suspense
          fallback={fallback ?? <div className="absolute inset-0 bg-background" aria-hidden="true" />}
        >
          <View key={kind} ionToken={ionToken} onReady={handleReady} />
        </Suspense>
      )}
    </div>
  );
}
