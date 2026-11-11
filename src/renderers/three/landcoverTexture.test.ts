import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedWorld } from '@/lib/world/loadWorld';
import { buildLandcoverCanvas, LANDCOVER_COLORS, WATER_COLOR } from './landcoverTexture';

/** A 2D context that logs every fill and stroke with its colour. */
function recordingCanvas(log: string[]) {
  const ctx: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1 };
  for (const m of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'save', 'restore', 'clip', 'rect']) ctx[m] = () => {};
  ctx.fill = () => log.push(`fill ${String(ctx.fillStyle)}`);
  ctx.stroke = () => log.push(`stroke ${String(ctx.strokeStyle)}`);
  return class {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return ctx;
    }
  };
}

const square = (x: number, y: number, s: number) => new Float32Array([x, y, x + s, y, x + s, y + s, x, y + s]);

function world(landcover: { kind: string; rings: Float32Array[] }[]): LoadedWorld {
  return {
    manifest: { extent: { xMin: 0, xMax: 1000, yMin: 0, yMax: 1000 } },
    landcover: { areas: landcover },
    water: { areas: [{ kind: 'pond', rings: [square(800, 800, 50)] }], lines: [{ width: 2.5, points: new Float32Array([0, 500, 1000, 500]) }] },
    roads: { roads: [] },
  } as unknown as LoadedWorld;
}

describe('landcover texture: streams on a coast', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('strokes streams under the beach sand on a coast, and last of all inland', () => {
    const coast: string[] = [];
    vi.stubGlobal('OffscreenCanvas', recordingCanvas(coast));
    expect(buildLandcoverCanvas(world([{ kind: 'grass', rings: [square(0, 0, 400)] }, { kind: 'beach', rings: [square(400, 400, 200)] }]), 64)).not.toBeNull();
    const stream = coast.indexOf(`stroke ${WATER_COLOR}`);
    expect(stream).toBeGreaterThan(coast.indexOf(`fill ${LANDCOVER_COLORS.grass}`));
    expect(stream).toBeLessThan(coast.indexOf(`fill ${LANDCOVER_COLORS.beach}`));
    expect(coast.filter((e) => e === `stroke ${WATER_COLOR}`)).toHaveLength(1);

    const inland: string[] = [];
    vi.stubGlobal('OffscreenCanvas', recordingCanvas(inland));
    buildLandcoverCanvas(world([{ kind: 'grass', rings: [square(0, 0, 400)] }]), 64);
    const lastColour = inland.filter((e) => e.startsWith('fill #') || e.startsWith('stroke #')).filter((e) => !e.includes('rgb')).at(-1);
    expect(lastColour).toBe(`stroke ${WATER_COLOR}`);
    expect(inland.indexOf(`stroke ${WATER_COLOR}`)).toBeGreaterThan(inland.indexOf(`fill ${WATER_COLOR}`));
  });
});
