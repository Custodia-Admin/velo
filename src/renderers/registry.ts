/**
 * The renderers this build ships, each behind a dynamic import() so a
 * renderer's engine (Cesium, three.js) downloads only when it draws.
 *
 * 'world' (Velo's own token-free three.js renderer) lands in packet P1.4;
 * until then it has no loader here and `resolveRenderer` falls back to
 * 'photoreal', which without an ion token is the OSM map fallback the ride
 * has always used. P1.4 adds the loader and nothing else changes.
 */

import type { ComponentType } from 'react';

import {
  resolveRenderer,
  type RendererKind,
  type WorldViewProps,
} from '@/lib/world/renderer';

export type WorldViewComponent = ComponentType<WorldViewProps>;

export const RENDERER_LOADERS: Readonly<
  Record<RendererKind, (() => Promise<WorldViewComponent>) | null>
> = {
  world: null,
  photoreal: () =>
    import('@/renderers/cesium/CesiumWorldView').then((m) => m.CesiumWorldView),
};

export const AVAILABLE_RENDERERS: ReadonlySet<RendererKind> = new Set(
  (Object.keys(RENDERER_LOADERS) as RendererKind[]).filter((k) => RENDERER_LOADERS[k] !== null),
);

/** The renderer that will draw for this preference in this build. */
export function rendererFor(preferred: RendererKind): RendererKind {
  return resolveRenderer(preferred, AVAILABLE_RENDERERS);
}
