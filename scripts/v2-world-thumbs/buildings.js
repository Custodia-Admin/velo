// Buildings: extruded footprints with stone / plaster walls, hipped
// terracotta roofs where the footprint allows, windows (lit at night).
import * as THREE from 'three';
import { mulberry32 } from './world.js';
import { patchMaterial } from './atmosphere.js';

// Umbrian plaster: ochre, cream, warm sand, faded terracotta pink, pale grey-white
const WALLS = ['#c9a066', '#d4ad72', '#ddc79c', '#e4d6b6', '#d9bf8f', '#c98f6c', '#d2a184', '#cfc6b3', '#bfa98a', '#e0cfa8', '#c4945f', '#d8b07a'];
// stone: Subasio pink limestone (Assisi), travertine, grey sandstone (Perugia)
const STONE = ['#d6b7a0', '#cdb29a', '#c2b39c', '#b5a590', '#a99c88', '#d0c0a6'];
const ROOFS = ['#a85b3d', '#b5694a', '#9c5940', '#8f5641', '#b87657', '#a4644b', '#9a6a52', '#a8734f', '#8e5a45', '#b2805e'];
// historic centres on the hills: taller, denser, mostly stone
const OLD_TOWNS = [{ x: -146, y: 140, r: 1150 }, { x: 18233, y: -4364, r: 950 }];
const IND_WALL = ['#c2c0b8', '#b6b3aa', '#d0cdc4'];
const IND_ROOF = ['#8f8e8a', '#9da1a3', '#7d7b76', '#a9a49a'];

function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) continue;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

/**
 * Build merged building geometry for buildings within `radius` of (cx, cy)
 * and passing `visible(x,y)`. Attributes: position, normal, color, aWall (u, v, isWall, seed).
 */
export function buildBuildings(world, hf, cx, cy, radius, visible) {
  const bd = world.buildings;
  const P = [], N = [], C = [], A = [];
  const col = new THREE.Color(), rc = new THREE.Color();
  const push = (x, h, y, nx, ny, nz, c, u, v, wall, seed) => {
    P.push(x, h, -y); N.push(nx, ny, nz); C.push(c.r, c.g, c.b); A.push(u, v, wall, seed);
  };
  const tri = (a, b, c, color, seed) => {
    // a,b,c = [x, y, h]; normal from winding (three coords)
    const ax = a[0], ay = a[2], az = -a[1], bx = b[0], by = b[2], bz = -b[1], cx2 = c[0], cy2 = c[2], cz = -c[1];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx2 - ax, vy = cy2 - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; [b, c] = [c, b]; }
    for (const p of [a, b, c]) push(p[0], p[2], p[1], nx, ny, nz, color, 0, 0, 0, seed);
  };
  let count = 0;
  for (let i = 0; i < bd.count; i++) {
    const s = bd.start[i], e = bd.start[i + 1];
    const x0 = bd.xy[s * 2], y0 = bd.xy[s * 2 + 1];
    if (Math.hypot(x0 - cx, y0 - cy) > radius) continue;
    if (!visible(x0, y0)) continue;
    const pts = [];
    for (let k = s; k < e; k++) pts.push([bd.xy[k * 2], bd.xy[k * 2 + 1]]);
    if (area(pts) < 0) pts.reverse();
    const kind = bd.kind[i];
    const rng = mulberry32(i * 2654435761);
    let minH = Infinity, maxH = -Infinity, cxp = 0, cyp = 0;
    for (const p of pts) { const h = hf.sample(p[0], p[1]); minH = Math.min(minH, h); maxH = Math.max(maxH, h); cxp += p[0]; cyp += p[1]; }
    cxp /= pts.length; cyp /= pts.length;
    const ind = kind === 4 || kind === 5;
    const oldTown = OLD_TOWNS.some((t) => Math.hypot(cxp - t.x, cyp - t.y) < t.r);
    // footprint heights are mostly per-type defaults: vary by whole floors
    let hgt = bd.height[i] || 7;
    if (!ind && kind !== 3) {
      const floors = Math.max(1, Math.round((hgt - 1) / 3.2));
      const df = rng() < 0.5 ? 0 : rng() < 0.55 ? 1 : -1;
      hgt = Math.max(3.6, (floors + df + (oldTown ? (rng() < 0.6 ? 1 : 2) : 0)) * 3.2 + 1 + rng() * 0.8);
    }
    const base = minH - 1.0;
    const top = Math.max(minH + hgt, maxH + Math.min(hgt, 4));
    const ar = Math.abs(area(pts));
    const church = kind === 3;
    const stone = church || rng() < (oldTown ? 0.7 : 0.22);
    const wallHex = ind ? IND_WALL[Math.floor(rng() * IND_WALL.length)] : stone ? STONE[Math.floor(rng() * STONE.length)] : WALLS[Math.floor(rng() * WALLS.length)];
    col.set(wallHex);
    col.multiplyScalar(0.82 + rng() * 0.3);
    const roofHex = ind && ar > 300 ? IND_ROOF[Math.floor(rng() * IND_ROOF.length)] : ROOFS[Math.floor(rng() * ROOFS.length)];
    rc.set(roofHex).multiplyScalar(0.78 + rng() * 0.34);
    if (!ind && rng() < 0.3) rc.lerp(new THREE.Color('#7d6a5c'), 0.35); // old weathered coppi
    const seed = rng() * (stone ? -1 : 1);
    // walls
    let u = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.05) continue;
      const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len; // outward for CCW (world xy)
      const n3 = [nx, 0, -ny];
      const wl = len > 2.6 ? 1 : 0.5;
      const v0 = 0, v1 = top - base;
      const quad = [[a, base, u, v0], [b, base, u + len, v0], [b, top, u + len, v1], [a, base, u, v0], [b, top, u + len, v1], [a, top, u, v1]];
      for (const [p, h, uu, vv] of quad) push(p[0], h, p[1], n3[0], n3[1], n3[2], col, uu, vv - 1.0 + (base - minH + 1.0), wl * (ind ? 0.5 : 1), seed);
      u += len;
    }
    // roof
    const convex = isConvex(pts);
    const pitched = !ind && !church && convex && pts.length <= 10 && ar < 1800 && ar > 15 ? true : (church && convex && pts.length <= 10);
    if (pitched) {
      // hip roof: for near-rectangles a ridge along the long axis, else a pyramid
      const pitch = Math.tan((20 + rng() * 6) * Math.PI / 180);
      if (pts.length === 4) {
        const e0 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        const e1 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
        const long = e0 >= e1 ? 0 : 1;
        const Wd = Math.min(e0, e1);
        const rh = (Wd / 2) * pitch;
        const ctr = [cxp, cyp];
        const ax = long === 0 ? [(pts[1][0] - pts[0][0]) / e0, (pts[1][1] - pts[0][1]) / e0] : [(pts[2][0] - pts[1][0]) / e1, (pts[2][1] - pts[1][1]) / e1];
        const half = Math.max(0, (Math.max(e0, e1) - Wd) / 2);
        const r1 = [ctr[0] - ax[0] * half, ctr[1] - ax[1] * half, top + rh];
        const r2 = [ctr[0] + ax[0] * half, ctr[1] + ax[1] * half, top + rh];
        for (let k = 0; k < 4; k++) {
          const a = [...pts[k], top], b = [...pts[(k + 1) % 4], top];
          // pick nearer ridge point for each eave corner
          const ra = Math.hypot(a[0] - r1[0], a[1] - r1[1]) < Math.hypot(a[0] - r2[0], a[1] - r2[1]) ? r1 : r2;
          const rb = Math.hypot(b[0] - r1[0], b[1] - r1[1]) < Math.hypot(b[0] - r2[0], b[1] - r2[1]) ? r1 : r2;
          tri(a, b, rb, rc, seed);
          if (ra !== rb) tri(a, rb, ra, rc, seed);
        }
      } else {
        const rh = Math.min(3.2, Math.sqrt(ar) * 0.5 * pitch);
        const apex = [cxp, cyp, top + rh];
        for (let k = 0; k < pts.length; k++) tri([...pts[k], top], [...pts[(k + 1) % pts.length], top], apex, rc, seed);
      }
    } else {
      const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { tris = []; }
      const roofC = ind ? rc : rc.clone().lerp(new THREE.Color('#9b8f7c'), 0.25);
      for (const t of tris) tri([...pts[t[0]], top], [...pts[t[1]], top], [...pts[t[2]], top], roofC, seed);
    }
    count++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aWall', new THREE.Float32BufferAttribute(A, 4));
  g.userData.count = count;
  return g;
}

export function makeBuildingMaterial(U, envMap) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMap, envMapIntensity: 0.8 });
  return patchMaterial(mat, U, {
    key: 'bld',
    vertexPars: 'attribute vec4 aWall; varying vec4 vWall;',
    vertexMain: 'vWall = aWall;',
    fragmentPars: `varying vec4 vWall; float gWin = 0.0; float gLit = 0.0;
      float bh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
    fragmentReplace: [
      ['#include <color_fragment>', `#include <color_fragment>
        if (vWall.z > 0.0) {
          float u = vWall.x, v = vWall.y;
          float pxW = length(fwidth(vec2(u, v)));
          // plaster stains, rain streaks under the eaves, darker damp plinth
          float sw = abs(vWall.w);
          diffuseColor.rgb *= 0.9 + 0.12 * bh(floor(vec2(u * 0.4, v * 0.5)) + sw);
          float streak = bh(vec2(floor(u * 1.7), sw * 31.0));
          diffuseColor.rgb *= 1.0 - 0.12 * smoothstep(0.55, 1.0, streak) * (0.5 + 0.5 * sin(u * 0.9 + sw * 40.0));
          diffuseColor.rgb *= mix(0.66, 1.0, smoothstep(0.0, 1.6, v));
          if (vWall.w < 0.0 && pxW < 0.6) {
            // stone: irregular coursing
            float course = floor(v / 0.42);
            float blk = bh(vec2(floor(u / (0.6 + 0.5 * bh(vec2(course, sw)))), course) + sw);
            diffuseColor.rgb *= 0.86 + 0.22 * blk;
            float joint = smoothstep(0.06, 0.0, fract(v / 0.42)) ;
            diffuseColor.rgb *= 1.0 - 0.18 * joint * (1.0 - smoothstep(0.2, 0.6, pxW));
          }
          if (vWall.z > 0.75 && pxW < 0.9) {
            float fl = floor((v - 0.9) / 3.1);
            vec2 cellUv = vec2(fract(u / 3.4), fract((v - 0.9) / 3.1));
            float win = step(0.32, cellUv.x) * step(cellUv.x, 0.68) * step(0.18, cellUv.y) * step(cellUv.y, 0.72) * step(0.0, fl);
            win *= 1.0 - smoothstep(0.4, 0.9, pxW);
            float id = bh(vec2(floor(u / 3.4), fl) + vWall.w * 17.0);
            gWin = win;
            gLit = step(0.62, id) * win;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.028, 0.032) + vec3(0.04, 0.03, 0.02) * id, win * 0.85);
            // green/brown wooden shutters on some windows
            float sh = step(0.45, id) * step(id, 0.8) * win * step(abs(cellUv.x - 0.5), 0.2);
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.12, 0.16, 0.10), vec3(0.22, 0.13, 0.07), step(0.62, id)), sh * 0.9);
          }
        } else {
          // roof: coppi tile mottling and moss/age
          vec2 rp = vec2(vWPos.x, -vWPos.z);
          float tiles = bh(floor(rp * vec2(3.0, 1.2)));
          float age = bh(floor(rp * 0.35) + abs(vWall.w) * 9.0);
          diffuseColor.rgb *= 0.86 + 0.24 * tiles;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.76, 0.72), smoothstep(0.6, 1.0, age) * 0.6);
        }`],
      ['#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.25, gWin);`],
      ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.62, 0.28) * gLit * uNight * 2.2;`],
    ],
  });
}
