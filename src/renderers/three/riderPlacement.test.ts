/**
 * Blueprint §P1.4 acceptance: the rider never intersects or floats. 200
 * points along each shipped Perugia route, through the real loader and the
 * real placement code the renderer uses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { ridePose } from '@/lib/ride/rideSim';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { loadWorld, type LoadedWorld } from '@/lib/world/loadWorld';
import { ROUTE_LIFT_M, buildRouteChunks, routeLine } from './Roads';
import { RIDER_RIG, leanAngle, legIK, legPose, modelYaw, placeRider } from './riderRig';
import { lodHeightAt } from './terrainMesh';
import { createSceneWorld, drawnGround, type SceneWorld } from './worldScene';

const DIR = fileURLToPath(new URL('../../../public/worlds/perugia', import.meta.url));
const diskFetch = async (url: string) => {
  try {
    return new Response(readFileSync(join(DIR, url.replace(/^.*\//, ''))), { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
};

const ROUTES = ['scenic-perugia-tiber-park', 'scenic-assisi-valley'];
const SAMPLES = 200;

describe('rider placement on the Perugia world', () => {
  let world: LoadedWorld;
  let sw: SceneWorld;
  beforeAll(async () => {
    world = await loadWorld('/worlds/perugia/', { fetch: diskFetch, verifyHashes: false });
    sw = createSceneWorld(world);
  }, 60_000);

  for (const id of ROUTES) {
    it(`${id}: rider sits on the bake's own route samples (x, y, h) at ${SAMPLES} points`, () => {
      // Independent oracle: tools/worldbake computed these offline (routes.json:
      // world x/y per 10 m of the app's distance scale, h = render elevation).
      // The runtime path (ridePose → projection → heightfield) must land on them.
      const route = routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
      const baked = world.routes.find((r) => r.id === id)!;
      expect(baked.s.length).toBeGreaterThan(SAMPLES);
      let worstXY = 0;
      let worstH = 0;
      for (let k = 0; k < SAMPLES; k++) {
        const i = Math.round(((baked.s.length - 1) * k) / (SAMPLES - 1));
        const p = placeRider(sw, ridePose(route, baked.s[i]));
        worstXY = Math.max(worstXY, Math.hypot(p.position.x - baked.x[i], -p.position.z - baked.y[i]));
        worstH = Math.max(worstH, Math.abs(p.position.y - baked.h[i]));
      }
      // x/y are stored to 1 cm; between 10 m samples the route is linear on both sides.
      expect(worstXY).toBeLessThan(0.05);
      expect(worstH).toBeLessThan(0.05);
    });

    it(`${id}: |riderY − ground| < 0.05 m at ${SAMPLES} route points with any lane offset`, () => {
      // Ground from the raw nodes with a test-local bilinear, not Heightfield.sampleHeight.
      const hf = world.heightfield;
      const { cellSize, xMin, yMax } = hf.spec;
      const ground = (x: number, y: number) => {
        const fx = (x - xMin) / cellSize;
        const fy = (yMax - y) / cellSize;
        const c = Math.floor(fx);
        const r = Math.floor(fy);
        const tx = fx - c;
        const ty = fy - r;
        const top = hf.nodeHeight(c, r) * (1 - tx) + hf.nodeHeight(c + 1, r) * tx;
        const bot = hf.nodeHeight(c, r + 1) * (1 - tx) + hf.nodeHeight(c + 1, r + 1) * tx;
        return top * (1 - ty) + bot * ty;
      };
      const route = routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
      let worst = 0;
      for (let k = 0; k < SAMPLES; k++) {
        const d = (route.totalDistance * k) / (SAMPLES - 1);
        for (const lane of [0, 1.6, -1.6]) {
          const p = placeRider(sw, ridePose(route, d, { laneOffsetM: lane }));
          expect(hf.contains(p.worldX, p.worldY)).toBe(true);
          worst = Math.max(worst, Math.abs(p.position.y - ground(p.position.x, -p.position.z)));
        }
      }
      expect(worst).toBeLessThan(0.05);
    });

    it(`${id}: one height source — the rider stands on the drawn terrain triangles and on the drawn route line, at every LOD`, () => {
      const route = routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
      const hf = world.heightfield;
      for (const [lod, step] of [
        ['near', 1],
        ['far', 4],
      ] as const) {
        // Every chunk showing `lod`, as the terrain draws it.
        const vis = { near: new Uint8Array(sw.chunks.length).fill(lod === 'near' ? 1 : 0) };
        const ground = drawnGround(sw, vis, { near: 1, far: 4 });
        // The route line as drawn at that LOD: 2 m vertex pairs on the same triangles.
        const cx: number[] = [];
        const cz: number[] = [];
        const cy: number[] = [];
        for (const piece of buildRouteChunks(sw, routeLine(sw, route, [1, 1, 1]), { near: 1, far: 4 })) {
          const chunk = sw.chunks[piece.chunk];
          const pos = piece[lod].positions;
          for (let v = 0; v + 1 < pos.length / 3; v += 2) {
            cx.push((pos[v * 3] + pos[v * 3 + 3]) / 2 + chunk.centerX);
            cy.push((pos[v * 3 + 1] + pos[v * 3 + 4]) / 2);
            cz.push((pos[v * 3 + 2] + pos[v * 3 + 5]) / 2 + chunk.centerZ);
          }
        }
        let worstLine = 0;
        let worstTerrain = 0;
        for (let k = 0; k < SAMPLES; k++) {
          const d = (route.totalDistance * k) / (SAMPLES - 1);
          const p = placeRider(sw, ridePose(route, d), ground);
          // Match by nearest vertex pair (≤ 1 m away along the 2 m spacing).
          let j = 0;
          let best = Infinity;
          for (let v = 0; v < cx.length; v++) {
            const dd = (cx[v] - p.position.x) ** 2 + (cz[v] - p.position.z) ** 2;
            if (dd < best) {
              best = dd;
              j = v;
            }
          }
          worstLine = Math.max(worstLine, Math.abs(cy[j] - ROUTE_LIFT_M - p.position.y));
          const chunk = sw.chunks[sw.locate(p.worldX, p.worldY)];
          worstTerrain = Math.max(worstTerrain, Math.abs(lodHeightAt(hf, chunk, step, p.worldX, p.worldY) - p.position.y));
        }
        // The wheels touch the drawn triangles exactly …
        expect(worstTerrain, `${lod}: |rider − drawn terrain|`).toBeLessThan(1e-6);
        // … and the line, ≤ 1 m away along a slope, rises or falls a few cm.
        expect(worstLine, `${lod}: |rider − drawn route line|`).toBeLessThan(lod === 'near' ? 0.08 : 0.15);
      }
    });
  }
});

describe('rider model (public/models/velo-rider.glb)', () => {
  const glbJson = () => {
    const b = readFileSync(fileURLToPath(new URL('../../../public/models/velo-rider.glb', import.meta.url)));
    expect(b.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
    const len = b.readUInt32LE(12);
    return JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as {
      nodes: { name?: string }[];
      materials: { name?: string }[];
    };
  };

  it('has every animated node and recolourable material the renderer drives', () => {
    const j = glbJson();
    const nodes = new Set(j.nodes.map((n) => n.name));
    for (const n of ['wheelFront', 'wheelRear', 'crank', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'frame', 'riderBody']) {
      expect(nodes.has(n), n).toBe(true);
    }
    const mats = new Set(j.materials.map((m) => m.name));
    for (const m of ['frame', 'wheel', 'kit', 'skin', 'helmet', 'accent']) expect(mats.has(m), m).toBe(true);
  });

  it('matches the generator rig (scripts/gen-rider-glb.mjs)', async () => {
    const { RIG } = (await import('../../../scripts/gen-rider-glb.mjs')) as { RIG: Record<string, unknown> };
    for (const k of ['wheelRadius', 'crankLength', 'thigh', 'shin', 'ankleAbovePedal'] as const) {
      expect(RIG[k], k).toBe(RIDER_RIG[k]);
    }
    expect(RIG.bb).toEqual([...RIDER_RIG.bb]);
    expect(RIG.hip).toEqual([...RIDER_RIG.hip]);
  });
});

describe('rider rig', () => {
  it('model yaw turns the +X-forward model onto the compass heading', () => {
    // three.js yaw θ maps +X to (cos θ, 0, −sin θ); north is −z.
    for (const h of [0, Math.PI / 2, Math.PI, 4]) {
      const y = modelYaw(h);
      expect(Math.cos(y)).toBeCloseTo(Math.sin(h));
      expect(-Math.sin(y)).toBeCloseTo(-Math.cos(h));
    }
  });

  it('pitches nose-up on a climb from the ground under the wheels', () => {
    const fake = {
      projection: { forward: () => [0, 0] as [number, number] },
      heightfield: { sampleHeight: (_x: number, y: number) => 100 + 0.08 * y },
    } as unknown as SceneWorld;
    const p = placeRider(fake, { lat: 0, lon: 0, heading: 0 });
    expect(p.pitch).toBeCloseTo(Math.atan(0.08), 6);
    expect(placeRider(fake, { lat: 0, lon: 0, heading: Math.PI }).pitch).toBeCloseTo(-Math.atan(0.08), 6);
  });

  it('with a drawn surface, both wheels and the contact point stand on it, not on the heightfield', () => {
    const fake = {
      projection: { forward: () => [0, 0] as [number, number] },
      heightfield: { sampleHeight: (_x: number, y: number) => 100 + 0.08 * y },
    } as unknown as SceneWorld;
    // The drawn triangles: flat under the rear wheel, 0.4 m up under the front (a far-LOD facet).
    const surface = (_x: number, y: number) => (y > 0.1 ? 100.4 : 100);
    const p = placeRider(fake, { lat: 0, lon: 0, heading: 0 }, surface);
    expect(p.position.y).toBe(100);
    expect(p.pitch).toBeCloseTo(Math.atan2(0.4, 2 * RIDER_RIG.halfWheelbase), 6);
    // Facing south the front wheel is on the low side and the rear on the 0.4 m step.
    expect(placeRider(fake, { lat: 0, lon: 0, heading: Math.PI }, surface).pitch).toBeCloseTo(
      -Math.atan2(0.4, 2 * RIDER_RIG.halfWheelbase),
      6,
    );
  });

  it('two-bone leg IK keeps both segment lengths and bends the knee forward', () => {
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      for (const side of [1, -1] as const) {
        const p = legPose(a, side);
        const thigh = Math.hypot(p.knee[0] - RIDER_RIG.hip[0], p.knee[1] - RIDER_RIG.hip[1]);
        const shin = Math.hypot(p.ankle[0] - p.knee[0], p.ankle[1] - p.knee[1]);
        expect(thigh).toBeCloseTo(RIDER_RIG.thigh, 3);
        expect(shin).toBeCloseTo(RIDER_RIG.shin, 2);
        expect(p.knee[0]).toBeGreaterThan(RIDER_RIG.hip[0]);
      }
    }
    // Out of reach straightens instead of failing.
    const k = legIK([0, 0], [0, -2], 0.45, 0.44);
    expect(Number.isFinite(k[0]) && Number.isFinite(k[1])).toBe(true);
  });

  it('leans into corners, capped', () => {
    expect(leanAngle(8, 0)).toBe(0);
    expect(leanAngle(8, 0.3)).toBeGreaterThan(0);
    expect(leanAngle(8, -0.3)).toBeLessThan(0);
    expect(leanAngle(20, 5)).toBeLessThanOrEqual((25 * Math.PI) / 180);
  });
});
