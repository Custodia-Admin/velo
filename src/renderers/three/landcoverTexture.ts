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
  width: number;
  height: number;
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
  return { canvas, width, height };
}
