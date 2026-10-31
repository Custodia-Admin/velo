/**
 * The renderers this build ships, each behind a dynamic import() so a
 * renderer's engine (Cesium, three.js) downloads only when it draws.
 *
 * 'world' is Velo's own token-free three.js renderer; it draws routes that
 * lie inside a baked world bundle (lib/world/catalog). Any other route — and
 * a world that fails to load — rides on 'photoreal' (Cesium; without an ion
 * token, the OSM map fallback).
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
  world: () => import('@/renderers/three/ThreeWorldView').then((m) => m.ThreeWorldView),
  photoreal: () =>
    import('@/renderers/cesium/CesiumWorldView').then((m) => m.CesiumWorldView),
};

export const AVAILABLE_RENDERERS: ReadonlySet<RendererKind> = new Set(
  (Object.keys(RENDERER_LOADERS) as RendererKind[]).filter((k) => RENDERER_LOADERS[k] !== null),
);

/**
 * The renderer that will draw for this preference in this build. `canWorld`
 * says whether the world renderer can draw this ride (a baked world covers
 * the route and it has not failed); when it can't, the ride goes photoreal.
 */
export function rendererFor(preferred: RendererKind, canWorld = true): RendererKind {
  if (canWorld) return resolveRenderer(preferred, AVAILABLE_RENDERERS);
  const withoutWorld = new Set([...AVAILABLE_RENDERERS].filter((k) => k !== 'world'));
  return resolveRenderer(preferred, withoutWorld);
}
