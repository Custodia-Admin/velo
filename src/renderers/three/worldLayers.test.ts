/**
 * World layers on the shipped Perugia bundle and their pure helpers: tree
 * field + ring selection (the 150k balanced budget), building palettes and
 * extrusion, water surfaces and river beds, street lamps, place-name picking,
 * the rain box.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadWorld, type BuildingsLayer, type LoadedWorld } from '@/lib/world/loadWorld';
import type { WorldPoi } from '@/lib/world/manifest';

import { ASSISI_X, buildBuildingGeometry, buildingStyle, DISTRICT_INDUSTRIAL, DISTRICT_OLD, mulberry32, PLASTER, STONE_PINK } from './buildingMesh';
import { streetLampPositions } from './Buildings';
import { LABEL_DEDUPE_M, pickLabels } from './landmarks';
import { THREE_QUALITY } from './quality';
import { buildTreeField, gatherShape, selectTreeRings, speciesFor, TREE_SHAPES, TREE_STRIDE, type TreeField } from './treeField';
import { treeTriangles } from './treeShapes';
import { autumnFor } from './Vegetation';
import { buildWaterGeometry, WATER_BED_DEPTH_M } from './waterMesh';
import { createRainGeometry } from './Weather';
import { syntheticHeightfield } from './syntheticWorld';
import { createSceneWorld, type SceneWorld } from './worldScene';

const DIR = fileURLToPath(new URL('../../../public/worlds/perugia', import.meta.url));
const diskFetch = async (url: string) => {
  try {
    return new Response(readFileSync(join(DIR, url.replace(/^.*\//, ''))), { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
};

describe('world layers on the Perugia bundle', () => {
  let world: LoadedWorld;
  let sw: SceneWorld;
  let field: TreeField;
  beforeAll(async () => {
    world = await loadWorld('/worlds/perugia/', { fetch: diskFetch });
    sw = createSceneWorld(world);
    field = buildTreeField(world.vegetation, world.heightfield, world.manifest.extent);
  });

  it('indexes every tree once, sorted by cell and shape', () => {
    expect(field.count).toBe(world.vegetation.count);
    expect(field.start[field.start.length - 1]).toBe(field.count);
    expect(field.perShape.reduce((a, b) => a + b, 0)).toBe(field.count);
    // Every record sits on the ground with a positive size.
    for (let i = 0; i < field.count; i += 997) {
      const o = i * TREE_STRIDE;
      expect(field.data[o + 4]).toBeGreaterThan(1);
      expect(field.data[o + 5]).toBeGreaterThan(0);
      const ground = world.heightfield.sampleHeight(field.data[o], -field.data[o + 2]);
      expect(Math.abs(field.data[o + 1] - ground)).toBeLessThan(3);
    }
  });

  it('keeps every tier within its tree budget anywhere along the scenic routes', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const q = THREE_QUALITY[tier];
      for (const route of world.routes) {
        for (let k = 0; k < route.x.length; k += Math.max(1, Math.floor(route.x.length / 12))) {
          const x = route.x[k];
          const y = route.y[k];
          const sel = selectTreeRings(field, x, -y, q.treeNearM, q.treeFarM, q.maxTrees);
          expect(sel.total).toBeLessThanOrEqual(q.maxTrees);
          const near = sel.counts.reduce((a, c) => a + c[0], 0);
          const far = sel.counts.reduce((a, c) => a + c[1], 0);
          expect(near + far).toBe(sel.total);
        }
      }
    }
    expect(THREE_QUALITY.medium.maxTrees).toBeLessThanOrEqual(150_000);
  });

  it('fills the countryside around the Tiber route with trees at balanced', () => {
    const route = world.routes.find((r) => r.id === 'scenic-perugia-tiber-park') ?? world.routes[0];
    const x = route.x[0];
    const y = route.y[0];
    const q = THREE_QUALITY.medium;
    const sel = selectTreeRings(field, x, -y, q.treeNearM, q.treeFarM, q.maxTrees);
    expect(sel.total).toBeGreaterThan(20_000);
    const out = new Float32Array(sel.total * TREE_STRIDE);
    let gathered = 0;
    for (let s = 0; s < TREE_SHAPES.length; s++) gathered += gatherShape(field, sel.near, s, out) + gatherShape(field, sel.far, s, out);
    expect(gathered).toBe(sel.total);
  });

  it('keeps tree meshes cheap: ≤ 450 triangles near, ≤ 120 far', () => {
    for (const s of TREE_SHAPES) {
      expect(treeTriangles(s, 'near')).toBeLessThanOrEqual(450);
      expect(treeTriangles(s, 'far')).toBeLessThanOrEqual(120);
    }
  });

  it('extrudes old-town Perugia as stone with roofs, walls clear of the ground', () => {
    const b = world.buildings;
    const old: number[] = [];
    for (let i = 0; i < b.count && old.length < 200; i++) if (b.district[i] === DISTRICT_OLD) old.push(i);
    expect(old.length).toBeGreaterThan(50);
    const data = buildBuildingGeometry(b, old, world.heightfield, 0, 0);
    expect(data.count).toBe(old.length);
    expect(data.positions.length / 3).toBe(data.walls.length / 4);
    let stone = 0;
    let wallVerts = 0;
    let roofUp = 0;
    let roofVerts = 0;
    for (let v = 0; v < data.walls.length / 4; v++) {
      if (data.walls[v * 4 + 2] > 0) {
        wallVerts++;
        if (data.walls[v * 4 + 3] < 0) stone++;
      } else {
        roofVerts++;
        if (data.normals[v * 3 + 1] > 0.5) roofUp++;
      }
    }
    expect(stone / wallVerts).toBeGreaterThan(0.5);
    expect(roofUp).toBe(roofVerts);
  });

  it('builds water with river beds pressed into the terrain', () => {
    const data = buildWaterGeometry(world.water, world.heightfield);
    expect(data.positions.length).toBeGreaterThan(9 * 100);
    let pressed = 0;
    for (let i = 0; i < sw.waterBed.length; i++) if (sw.waterBed[i] > 0) pressed++;
    expect(pressed).toBeGreaterThan(200);
    expect(sw.waterBed.reduce((a, b) => Math.max(a, b), 0)).toBeCloseTo(WATER_BED_DEPTH_M, 3);
    const [tx, ty] = world.projection.forward(43.0826, 12.4458); // Tiber at Ponte San Giovanni
    let nearTiber = false;
    for (let i = 0; i < data.positions.length; i += 3) {
      if (Math.hypot(data.positions[i] - tx, -data.positions[i + 2] - ty) < 400) {
        nearTiber = true;
        break;
      }
    }
    expect(nearTiber).toBe(true);
  });

  it('lights the towns at night: lamps only near buildings, at lamp height', () => {
    const lamps = streetLampPositions(sw);
    expect(lamps.length / 3).toBeGreaterThan(500);
    expect(lamps.length / 3).toBeLessThan(60_000);
    for (let i = 0; i < lamps.length; i += 3 * 211) {
      const ground = world.heightfield.sampleHeight(lamps[i], -lamps[i + 2]);
      expect(lamps[i + 1] - ground).toBeCloseTo(6.5, 3);
    }
  });

  it('labels Perugia and Assisi from the Assisi route, nothing behind the camera', () => {
    const pois = world.manifest.pois;
    const [px, py] = world.projection.forward(43.1122, 12.3888);
    const [ax, ay] = world.projection.forward(43.0707, 12.6175);
    // Halfway, looking east at Assisi.
    const mx = (px + ax) / 2;
    const my = (py + ay) / 2;
    const east = pickLabels(pois, mx, my, 1, 0, 8);
    expect(east.length).toBeGreaterThan(0);
    expect(east.every((l) => l.poi.x > mx)).toBe(true);
    for (const a of east) for (const b of east) if (a !== b) expect(Math.hypot(a.poi.x - b.poi.x, a.poi.y - b.poi.y)).toBeGreaterThanOrEqual(LABEL_DEDUPE_M);
  });
});

describe('world layer helpers', () => {
  it('picks species deterministically per kind', () => {
    expect(speciesFor('cypress', 10).shape).toBe(TREE_SHAPES.indexOf('column'));
    expect(speciesFor('olive', 200).shape).toBe(TREE_SHAPES.indexOf('olive'));
    expect(speciesFor('riparian', 0).shape).toBe(TREE_SHAPES.indexOf('poplar'));
    expect(speciesFor('riparian', 255).shape).toBe(TREE_SHAPES.indexOf('round'));
    expect(speciesFor('broadleaf', 3)).toEqual(speciesFor('broadleaf', 3));
  });

  it('turns deciduous trees in autumn, green in summer', () => {
    expect(autumnFor(new Date(2026, 6, 15))).toBe(0);
    expect(autumnFor(new Date(2026, 10, 1))).toBeGreaterThan(0.3);
  });

  it('dresses Assisi in pink limestone and suburbs in plaster', () => {
    let pink = 0;
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const s = buildingStyle(0, DISTRICT_OLD, ASSISI_X + 500, 120, mulberry32(i + 1));
      if (s.stone) {
        n++;
        if (STONE_PINK.includes(s.wall)) pink++;
      }
    }
    expect(pink / n).toBeGreaterThan(0.7);
    let plaster = 0;
    for (let i = 0; i < 400; i++) if (PLASTER.includes(buildingStyle(0, 0, 0, 120, mulberry32(i + 1)).wall)) plaster++;
    expect(plaster / 400).toBeGreaterThan(0.75);
    expect(buildingStyle(4, DISTRICT_INDUSTRIAL, 0, 900, mulberry32(3)).pitched).toBe(false);
  });

  it('gives a rectangular house four walls and a hipped roof', () => {
    const layer: BuildingsLayer = {
      count: 1,
      start: Uint32Array.from([0, 4]),
      xy: Float32Array.from([0, 0, 12, 0, 12, 8, 0, 8]),
      height: Float32Array.from([7]),
      kind: Uint8Array.from([0]),
      district: Uint8Array.from([0]),
    } as BuildingsLayer;
    const d = buildBuildingGeometry(layer, [0], syntheticHeightfield(), 0, 0);
    // 4 walls × 6 verts + hip roof: 2 triangles on each long side, 1 on each end.
    expect(d.positions.length / 3).toBe(24 + 6 * 3);
    let maxY = -Infinity;
    for (let i = 1; i < d.positions.length; i += 3) maxY = Math.max(maxY, d.positions[i]);
    const ground = syntheticHeightfield().sampleHeight(6, 4);
    expect(maxY - ground).toBeGreaterThan(4);
  });

  it('builds the rain box as line pairs', () => {
    const g = createRainGeometry(100);
    expect(g.getAttribute('aDrop').count).toBe(200);
    expect(g.getAttribute('aEnd').getX(0)).toBe(0);
    expect(g.getAttribute('aEnd').getX(1)).toBe(1);
    g.dispose();
  });

  it('drops near-duplicate labels and out-of-range villages', () => {
    const pois: WorldPoi[] = [
      { name: 'Assisi', kind: 'town', x: 1000, y: 0, rank: 3 } as WorldPoi,
      { name: 'Basilica di San Francesco', kind: 'church', x: 1100, y: 0, rank: 2 } as WorldPoi,
      { name: 'Far hamlet', kind: 'village', x: 5000, y: 0, rank: 1 } as WorldPoi,
      { name: 'Behind', kind: 'town', x: -2000, y: 0, rank: 3 } as WorldPoi,
    ];
    const picks = pickLabels(pois, 0, 0, 1, 0, 8).map((p) => p.poi.name);
    expect(picks).toEqual(['Assisi']);
  });
});
