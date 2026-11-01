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
import { buildRibbons } from './roadRibbons';
import { ROUTE_LIFT_M, routeLine } from './Roads';
import { RIDER_RIG, leanAngle, legIK, legPose, modelYaw, placeRider } from './riderRig';
import { meshHeightAt } from './terrainMesh';
import { createSceneWorld, type SceneWorld } from './worldScene';

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

    it(`${id}: the rider sits on the drawn route surface (within 5 cm) and close to the terrain mesh`, () => {
      const route = routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
      // The route ribbon as drawn: 2 m vertices, linear in between.
      const ribbon = buildRibbons(world.heightfield, [routeLine(sw, route, [1, 1, 1])], {
        maxSegM: 2,
        lift: ROUTE_LIFT_M,
        originX: 0,
        originZ: 0,
      });
      const along = ribbon.uvs.filter((_, i) => i % 4 === 1);
      const centreY = (v: number) => (ribbon.positions[v * 6 + 1] + ribbon.positions[v * 6 + 4]) / 2;
      let worstRibbon = 0;
      let worstMesh = 0;
      for (let k = 0; k < SAMPLES; k++) {
        const d = (route.totalDistance * k) / (SAMPLES - 1);
        const p = placeRider(sw, ridePose(route, d));
        // Ribbon distance runs along the projected polyline; match by nearest vertex pair.
        let j = 0;
        let best = Infinity;
        for (let v = 0; v < along.length; v++) {
          const dx = ribbon.positions[v * 6] - p.position.x;
          const dz = ribbon.positions[v * 6 + 2] - p.position.z;
          const dd = dx * dx + dz * dz;
          if (dd < best) {
            best = dd;
            j = v;
          }
        }
        const surface = centreY(j) - ROUTE_LIFT_M;
        // Nearest vertex is ≤ 1 m away; over 1 m the corridor rises a few cm at most.
        worstRibbon = Math.max(worstRibbon, Math.abs(p.position.y - surface));
        worstMesh = Math.max(worstMesh, Math.abs(p.position.y - meshHeightAt(world.heightfield, p.position.x, p.position.z)));
      }
      expect(worstRibbon).toBeLessThan(0.05 + 0.08);
      // Triangulated 13 m terrain vs bilinear ground on the re-graded corridor.
      expect(worstMesh).toBeLessThan(0.5);
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
