/**
 * Landcover colour map for the terrain shader: the world's landcover and
 * water polygons, rivers and (faintly) roads rasterised onto a canvas, row
 * 0 = north. Farmland parcels each get their own crop colour so the valley
 * reads as the Umbrian patchwork rather than one green.
 *
 * Needs a 2D canvas (DOM or OffscreenCanvas); returns null without one
 * (unit tests), and the terrain falls back to a plain tint.
 */

import type { LoadedWorld, WorldArea } from '@/lib/world/loadWorld';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BASE = '#7f8c4e';

/** Fill colour per landcover kind (sRGB). Farmland picks from FIELDS. */
export const LANDCOVER_COLORS: Readonly<Record<string, string>> = {
  forest: '#3d5229',
  scrub: '#64703f',
  grass: '#82914f',
  park: '#6f8a45',
  farmland: '#a39a5c',
  orchard: '#738047',
  vineyard: '#7e7d47',
  residential: '#a69c8a',
  industrial: '#9a958c',
  cemetery: '#6f7a52',
};

/** Field colours: ripe wheat, stubble, ploughed earth, young green, fodder. */
export const FIELDS = ['#b5a466', '#a8955f', '#8e7553', '#7f8f4c', '#99a05a', '#b09a63', '#8a7c55'];

export const WATER_COLOR = '#36667f';

/** Draw order: broad covers first, built-up last, so towns sit on top. */
const ORDER = ['farmland', 'grass', 'scrub', 'orchard', 'vineyard', 'park', 'forest', 'cemetery', 'industrial', 'residential'];

function hashIndex(i: number): number {
  let h = (i + 1) * 2654435761;
  h ^= h >>> 15;
  return Math.abs(h);
}

export interface LandcoverCanvas {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /**
   * Aux map, same size: r = crop-row angle / π (rows run along each parcel's
   * longest edge), g = row kind (0.3 furrows, 0.6 orchard/olive rows, 0.9
   * vine rows, 0 none), b = woodland class (1 forest, 0.7 scrub).
   */
  aux: HTMLCanvasElement | OffscreenCanvas | null;
  width: number;
  height: number;
}

/** Row kind per landcover kind (aux green channel, 0–255). */
export const ROW_KIND: Readonly<Record<string, number>> = { farmland: 77, orchard: 153, vineyard: 230 };
/** Woodland class (aux blue channel, 0–255). */
export const WOOD_CLASS: Readonly<Record<string, number>> = { forest: 255, scrub: 178 };

/** Direction of a ring's longest edge, radians in [0, π). */
export function longestEdgeAngle(ring: Float32Array | number[]): number {
  let best = -1;
  let ang = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[2 * j] - ring[2 * i];
    const dy = ring[2 * j + 1] - ring[2 * i + 1];
    const l = dx * dx + dy * dy;
    if (l > best) {
      best = l;
      ang = Math.atan2(dy, dx);
    }
  }
  if (ang < 0) ang += Math.PI;
  return ang >= Math.PI ? ang - Math.PI : ang;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  return null;
}

export function buildLandcoverCanvas(world: LoadedWorld, texels: number): LandcoverCanvas | null {
  const { xMin, xMax, yMin, yMax } = world.manifest.extent;
  const width = Math.max(64, Math.round(texels));
  const height = Math.max(32, Math.round((width * (yMax - yMin)) / (xMax - xMin)));
  const canvas = makeCanvas(width, height);
  const ctx = (canvas?.getContext('2d') ?? null) as Ctx | null;
  if (!canvas || !ctx) return null;
  const sx = width / (xMax - xMin);
  const sy = height / (yMax - yMin);
  const px = (x: number) => (x - xMin) * sx;
  const py = (y: number) => (yMax - y) * sy;

  ctx.fillStyle = BASE;
  ctx.fillRect(0, 0, width, height);

  const path = (area: WorldArea) => {
    ctx.beginPath();
    for (const ring of area.rings) {
      for (let i = 0; i + 1 < ring.length; i += 2) {
        if (i === 0) ctx.moveTo(px(ring[i]), py(ring[i + 1]));
        else ctx.lineTo(px(ring[i]), py(ring[i + 1]));
      }
      ctx.closePath();
    }
  };

  const byKind = new Map<string, { area: WorldArea; i: number }[]>();
  world.landcover.areas.forEach((area, i) => {
    const list = byKind.get(area.kind) ?? [];
    list.push({ area, i });
    byKind.set(area.kind, list);
  });
  for (const kind of [...ORDER, ...[...byKind.keys()].filter((k) => !ORDER.includes(k))]) {
    for (const { area, i } of byKind.get(kind) ?? []) {
      ctx.fillStyle = kind === 'farmland' ? FIELDS[hashIndex(i) % FIELDS.length] : (LANDCOVER_COLORS[kind] ?? BASE);
      path(area);
      ctx.fill('evenodd');
    }
  }

  // Roads, faintly: far terrain (no ribbons there) still shows the network.
  ctx.strokeStyle = 'rgba(150, 140, 122, 0.4)';
  ctx.lineCap = 'round';
  for (const road of world.roads.roads) {
    if (road.width < 4) continue;
    ctx.lineWidth = Math.max(0.6, road.width * sx);
    ctx.beginPath();
    const p = road.points;
    ctx.moveTo(px(p[0]), py(p[1]));
    for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(px(p[i]), py(p[i + 1]));
    ctx.stroke();
  }

  ctx.fillStyle = WATER_COLOR;
  for (const area of world.water.areas) {
    path(area);
    ctx.fill('evenodd');
  }
  ctx.strokeStyle = WATER_COLOR;
  for (const line of world.water.lines) {
    ctx.lineWidth = Math.max(1, line.width * sx);
    ctx.beginPath();
    const p = line.points;
    ctx.moveTo(px(p[0]), py(p[1]));
    for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(px(p[i]), py(p[i + 1]));
    ctx.stroke();
  }
  return { canvas, aux: buildAux(world, width, height, byKind), width, height };
}

function buildAux(
  world: LoadedWorld,
  width: number,
  height: number,
  byKind: Map<string, { area: WorldArea; i: number }[]>,
): HTMLCanvasElement | OffscreenCanvas | null {
  const aux = makeCanvas(width, height);
  const ctx = (aux?.getContext('2d') ?? null) as Ctx | null;
  if (!aux || !ctx) return null;
  const { xMin, xMax, yMin, yMax } = world.manifest.extent;
  const sx = width / (xMax - xMin);
  const sy = height / (yMax - yMin);
  const path = (area: WorldArea) => {
    ctx.beginPath();
    for (const ring of area.rings) {
      for (let i = 0; i + 1 < ring.length; i += 2) {
        const x = (ring[i] - xMin) * sx;
        const y = (yMax - ring[i + 1]) * sy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  };
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fillRect(0, 0, width, height);
  for (const kind of ORDER) {
    for (const { area } of byKind.get(kind) ?? []) {
      // Canvas y points south, so a world angle a maps to −a on the canvas; the shader works in world xy.
      const r = Math.round((longestEdgeAngle(area.rings[0]) / Math.PI) * 255);
      ctx.fillStyle = `rgb(${r},${ROW_KIND[kind] ?? 0},${WOOD_CLASS[kind] ?? 0})`;
      path(area);
      ctx.fill('evenodd');
    }
  }
  ctx.fillStyle = 'rgb(0,0,0)';
  for (const area of world.water.areas) {
    path(area);
    ctx.fill('evenodd');
  }
  return aux;
}
