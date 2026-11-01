// Trees: procedural crown templates (3 LODs) instanced from the world's
// vegetation seeds plus a dense scatter near the camera using the same
// landcover classes the ground texture was painted from.
import * as THREE from 'three';
import { mulberry32, hash2 } from './world.js';
import { patchMaterial } from './atmosphere.js';
import { FIELD_CELL, fieldCorner } from './ground.js';

const lin = (hex) => new THREE.Color(hex); // three converts sRGB hex -> linear

// species: trunk height/radius, crown ellipsoid (centre y, radius xz, radius y), colours
export const SPECIES = {
  oak: { trunkH: 3.4, trunkR: 0.28, cy: 6.6, rx: 3.6, ry: 3.1, col: '#55603a', top: '#77804a', shape: 'round' },
  holm: { trunkH: 2.4, trunkR: 0.25, cy: 5.0, rx: 3.0, ry: 2.6, col: '#3d4a2c', top: '#56623b', shape: 'round' },
  poplar: { trunkH: 3.0, trunkR: 0.25, cy: 10.5, rx: 2.3, ry: 7.2, col: '#5b6b36', top: '#7c8a47', shape: 'column' },
  cypress: { trunkH: 0.9, trunkR: 0.2, cy: 7.5, rx: 1.25, ry: 7.0, col: '#2c3a22', top: '#3d4c2b', shape: 'spindle' },
  pine: { trunkH: 9.0, trunkR: 0.3, cy: 10.6, rx: 4.6, ry: 1.7, col: '#38482a', top: '#4f5f35', shape: 'umbrella' },
  olive: { trunkH: 1.3, trunkR: 0.22, cy: 3.0, rx: 2.3, ry: 1.6, col: '#6c7556', top: '#949c7a', shape: 'olive' },
  bush: { trunkH: 0.2, trunkR: 0.1, cy: 1.1, rx: 1.5, ry: 1.1, col: '#555834', top: '#6f7044', shape: 'round' },
};

const smooth01 = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** Crown half-width at a normalised height t in [0,1] (shape profile). */
function crownProfile(sp, t) {
  switch (sp.shape) {
    case 'spindle': return Math.pow(Math.sin(Math.PI * Math.pow(Math.max(0.001, t), 0.62)), 0.9);
    case 'column': return Math.pow(Math.sin(Math.PI * Math.pow(Math.max(0.001, t), 0.75)), 0.8);
    case 'umbrella': return Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 2)));
    default: return Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 2)));
  }
}

/**
 * One tree template at a given LOD (0 ultra, 1 near, 2 far). The crown is a
 * cloud of alpha-tested leaf cards grouped into clumps (lumpy, gappy
 * silhouette), around a dark solid core so the crown is not see-through.
 * Attributes: position, normal (smooth crown normal), color (AO), aCard
 * (u, v, seed; u < 0 marks solid geometry that is never alpha-tested).
 */
function buildTree(sp, lod, seed) {
  const rng = mulberry32(seed * 7919 + lod * 104729);
  const P = [], N = [], C = [], A = [];
  const cBase = lin(sp.col), cTop = lin(sp.top);
  const base = sp.cy - sp.ry, H = 2 * sp.ry;
  const tmp = new THREE.Color();
  const crownNormal = (x, y, z) => {
    const t = (y - base) / H;
    const w = Math.max(0.15, crownProfile(sp, Math.min(1, Math.max(0, t)))) * sp.rx;
    return new THREE.Vector3(x / w, (y - sp.cy) / sp.ry * (sp.shape === 'umbrella' ? 1.6 : 1.0), z / w).normalize();
  };
  // surface point of the crown for a direction (az, t)
  const surf = (az, t, depth) => {
    const w = crownProfile(sp, t) * sp.rx * depth;
    let y = base + t * H;
    if (sp.shape === 'umbrella') y = sp.cy + (t - 0.5) * sp.ry * 1.4;
    return new THREE.Vector3(Math.cos(az) * w, y, Math.sin(az) * w);
  };
  // ---- clumps of leaf cards ----
  const nClumps = lod === 0 ? (sp.shape === 'spindle' || sp.shape === 'column' ? 30 : 22) : lod === 1 ? 14 : 6;
  const cardsPer = lod === 0 ? 34 : lod === 1 ? 14 : 6;
  const cardSize = Math.max(0.55, Math.min(sp.rx, sp.ry)) * (lod === 0 ? 0.36 : lod === 1 ? 0.55 : 0.95);
  const clumpR = Math.max(0.5, sp.rx * (sp.shape === 'spindle' ? 0.55 : 0.42));
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < nClumps; k++) {
    let t = rng();
    if (sp.shape === 'round' || sp.shape === 'olive' || sp.shape === 'umbrella') t = 0.18 + 0.8 * Math.pow(rng(), 0.7);
    const az = rng() * Math.PI * 2;
    const cc = surf(az, t, 0.55 + 0.3 * rng());
    const cr = clumpR * (0.7 + 0.6 * rng()) * (sp.shape === 'spindle' || sp.shape === 'column' ? Math.max(0.35, crownProfile(sp, t)) : 1);
    for (let j = 0; j < cardsPer; j++) {
      // point in the clump, biased outward
      const o = new THREE.Vector3(rng() * 2 - 1, (rng() * 2 - 1) * 0.8, rng() * 2 - 1);
      if (o.lengthSq() > 1) o.normalize();
      const c = cc.clone().addScaledVector(o, cr);
      const nOut = crownNormal(c.x, c.y, c.z);
      // card plane: random orientation leaning toward the outward normal
      const cn = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize().lerp(nOut, 0.55).normalize();
      const t1 = new THREE.Vector3().crossVectors(cn, Math.abs(cn.y) < 0.95 ? up : new THREE.Vector3(1, 0, 0)).normalize();
      const t2 = new THREE.Vector3().crossVectors(cn, t1);
      const rot = rng() * Math.PI;
      const e1 = t1.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t2, Math.sin(rot));
      const e2 = new THREE.Vector3().crossVectors(cn, e1);
      const sz = cardSize * (0.7 + 0.6 * rng());
      const cs = rng();
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      for (const [u, v] of corners) {
        const p = c.clone().addScaledVector(e1, u * sz * 0.5).addScaledVector(e2, v * sz * 0.5);
        const n = crownNormal(p.x, p.y, p.z).lerp(nOut, 0.4).normalize();
        P.push(p.x, p.y, p.z); N.push(n.x, n.y, n.z); A.push((u + 1) / 2, (v + 1) / 2, cs);
        // AO: darker deep inside and low in the crown, lighter on top
        const rr = Math.min(1.2, Math.hypot(p.x / sp.rx, (p.y - sp.cy) / sp.ry, p.z / sp.rx));
        const hy = Math.max(0, Math.min(1, (p.y - base) / H));
        const ao = 0.32 + 0.55 * smooth01((rr - 0.35) / 0.65) + 0.2 * hy;
        tmp.copy(cBase).lerp(cTop, Math.min(1, hy * 0.7 + Math.max(0, n.y) * 0.35 + (cs - 0.5) * 0.3)).multiplyScalar(ao);
        C.push(tmp.r, tmp.g, tmp.b);
      }
    }
  }
  // ---- solid parts: dark core + trunk/limbs ----
  const solids = [];
  const coreCol = lin(sp.col).multiplyScalar(0.28);
  if (sp.shape !== 'bush' || lod < 2) {
    const g = new THREE.IcosahedronGeometry(1, lod === 2 ? 0 : 1);
    const sc = sp.shape === 'umbrella' ? [sp.rx * 0.6, sp.ry * 0.45, sp.rx * 0.6] : [sp.rx * 0.6 * (sp.shape === 'spindle' ? 0.8 : 1), sp.ry * 0.62, sp.rx * 0.6 * (sp.shape === 'spindle' ? 0.8 : 1)];
    g.scale(...sc); g.translate(0, sp.cy, 0);
    solids.push([g.index ? g.toNonIndexed() : g, coreCol]);
  }
  const trunkCol = lin(sp.shape === 'olive' ? '#5e5649' : '#3e352d');
  const addCyl = (a, b, r0, r1, seg) => {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true).toNonIndexed();
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    g.translate(a.x, a.y, a.z);
    solids.push([g, trunkCol]);
  };
  if (lod < 2 || sp.shape === 'umbrella') {
    const top = new THREE.Vector3((rng() - 0.5) * 0.5, sp.trunkH + (sp.shape === 'umbrella' ? 0.6 : sp.ry * 0.4), (rng() - 0.5) * 0.5);
    addCyl(new THREE.Vector3(0, -0.4, 0), top, sp.trunkR * 1.3, sp.trunkR * 0.6, lod === 0 ? 8 : 5);
    if (lod === 0 && (sp.shape === 'olive' || sp.shape === 'umbrella' || sp.shape === 'round')) {
      for (let i = 0; i < 4; i++) {
        const a = rng() * Math.PI * 2;
        const end = new THREE.Vector3(Math.cos(a) * sp.rx * 0.6, sp.cy + (sp.shape === 'umbrella' ? 0 : (rng() - 0.3) * sp.ry * 0.5), Math.sin(a) * sp.rx * 0.6);
        addCyl(top.clone().multiplyScalar(0.75), end, sp.trunkR * 0.55, sp.trunkR * 0.22, 5);
      }
    }
  }
  for (const [g, col] of solids) {
    g.computeVertexNormals();
    const pos = g.attributes.position, nor = g.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      P.push(pos.getX(i), pos.getY(i), pos.getZ(i)); N.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      C.push(col.r, col.g, col.b); A.push(-1, -1, 0);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.setAttribute('aCard', new THREE.Float32BufferAttribute(A, 3));
  return geo;
}

// Procedural leaf-cluster alpha for a card (no textures): lobed, holey clump
// that degrades to a soft disc when the card is only a few pixels wide.
const LEAF_GLSL = /* glsl */ `
varying vec3 vCard;
float lh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float ln(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lh(i), lh(i + vec2(1, 0)), f.x), mix(lh(i + vec2(0, 1)), lh(i + vec2(1, 1)), f.x), f.y); }
// one jittered, rotated leaf ellipse per cell of a 6x6 grid, kept more often near
// the card centre: ragged edges and sky holes. Fades to a lumpy disc when the card
// is only a few pixels wide (avoids sparkle).
float leafAlpha() {
  if (vCard.x < 0.0) return 1.0;
  vec2 q = vCard.xy * 2.0 - 1.0;
  float d = dot(q, q);
  float sd = vCard.z * 53.0;
  float px = length(fwidth(vCard.xy));
  float far = smoothstep(0.05, 0.22, px);
  float lump = ln(vCard.xy * 3.5 + sd) * 0.5 + 0.75 - d;
  float leaves = 0.0;
  vec2 g = vCard.xy * 6.0;
  vec2 g0 = floor(g);
  for (int k = 0; k < 9; k++) {
    vec2 cid = g0 + vec2(float(k % 3) - 1.0, float(k / 3) - 1.0);
    float hsh = lh(cid + sd);
    vec2 ctr = cid + 0.5 + (vec2(lh(cid + sd + 3.1), lh(cid + sd + 7.7)) - 0.5) * 0.6;
    vec2 cq = ctr / 6.0 * 2.0 - 1.0;
    if (hsh > 1.05 - dot(cq, cq) * 1.1) continue;
    float ang = hsh * 6.2831;
    vec2 f = g - ctr;
    f = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * f;
    float e = (f.x * f.x) / 0.30 + (f.y * f.y) / 0.085;
    leaves = max(leaves, 1.0 - e);
  }
  return mix(leaves > 0.0 ? 1.0 : 0.0, lump, far);
}
`;

export function makeTreeMaterial(U, envMap) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, envMap, envMapIntensity: 0.9, side: THREE.DoubleSide });
  patchMaterial(mat, U, {
    key: 'tree',
    vertexPars: 'attribute vec3 aCard; varying vec3 vCard;',
    vertexMain: 'vCard = aCard;',
    fragmentPars: LEAF_GLSL,
    fragmentReplace: [
      ['#include <alphatest_fragment>', 'if (leafAlpha() < 0.5) discard;'],
      // cards are double sided but lit with the crown normal, never flipped
      ['#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);'],
    ],
    // light through leaves when backlit (only where the sun actually reaches)
    beforeAtmo: `{
      vec3 vd = normalize(vWPos - cameraPosition);
      float back = pow(max(dot(vd, uSunDir), 0.0), 4.0);
      float edge = vCard.x < 0.0 ? 0.0 : 1.0;
      gl_FragColor.rgb += diffuseColor.rgb * vec3(1.0, 0.82, 0.45) * gSunLit * (back * 1.6 + 0.05) * edge;
    }`,
  });
  return mat;
}

/** Shadow-pass material with the same leaf alpha so canopies cast dappled shadows. */
export function makeTreeDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aCard; varying vec3 vCard;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCard = aCard;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + LEAF_GLSL)
      .replace('#include <alphatest_fragment>', 'if (leafAlpha() < 0.5) discard;');
  };
  m.customProgramCacheKey = () => 'treeDepth';
  return m;
}

/** Choose a species for a seed kind (VEGETATION_KINDS order). */
function speciesForKind(kind, r, nearWater) {
  switch (kind) {
    case 0: return nearWater ? (r < 0.6 ? 'poplar' : 'oak') : r < 0.55 ? 'oak' : r < 0.9 ? 'holm' : 'pine';
    case 1: return r < 0.5 ? 'cypress' : 'pine';
    case 2: return r < 0.6 ? 'bush' : 'holm';
    case 3: return 'olive';
    default: return r < 0.4 ? 'oak' : r < 0.7 ? 'cypress' : 'pine';
  }
}

/**
 * Collect instances. ctx = { world, hf, camPos (world x,y,h), frustum, sampleMask(x,y), denseR, maxDist }
 * Returns map species -> array of [x, y, h, scale, rot, tint].
 */
export function collectTrees(ctx) {
  const { world, hf, cam, frustum, sampleMask, denseR, maxDist, exclude } = ctx;
  const out = {};
  for (const k of Object.keys(SPECIES)) out[k] = [];
  const v = new THREE.Vector3();
  const sphere = new THREE.Sphere(v, 25);
  const visible = (x, y, h) => { v.set(x, h + 6, -y); return frustum.intersectsSphere(sphere); };
  const add = (sp, x, y, s, seed, rx = 0) => {
    const h = hf.sample(x, y);
    if (!visible(x, y, h)) return;
    if (exclude && exclude(x, y)) return;
    const d = Math.hypot(x - cam.x, y - cam.y, h - cam.h);
    const far = 1 + 0.35 * Math.min(1, Math.max(0, (d - 900) / 3000));
    const r = hash2(seed, 77);
    out[sp].push([x, y, h - 0.2, s * far, r * Math.PI * 2, 0.66 + hash2(seed, 99) * 0.6, d]);
  };
  const okGround = (m) => m && m.water < 90 && m.road < 90;

  // 1. baked seeds
  const veg = world.vegetation;
  const md2 = maxDist * maxDist;
  for (let i = 0; i < veg.count; i++) {
    const x = veg.x[i], y = veg.y[i];
    const dx = x - cam.x, dy = y - cam.y;
    const dd = dx * dx + dy * dy;
    if (dd > md2) continue;
    const s = veg.seed[i];
    const k = veg.kind[i];
    if (dd < denseR * denseR && (k === 0 || k === 3 || k === 2)) continue; // dense scatter replaces these near the camera
    const m = sampleMask(x, y);
    if (m && !okGround(m)) continue;
    const sp = speciesForKind(k, (s & 15) / 16, false);
    add(sp, x, y, 0.75 + ((s >> 4) / 16) * 0.5, i * 13 + 5);
  }

  // 2. dense scatter near the camera
  const step = 4.6;
  const x0 = cam.x - denseR, x1 = cam.x + denseR, y0 = cam.y - denseR, y1 = cam.y + denseR;
  for (let gx = Math.floor(x0 / step); gx < x1 / step; gx++) {
    for (let gy = Math.floor(y0 / step); gy < y1 / step; gy++) {
      const hsh = hash2(gx, gy);
      const x = (gx + hash2(gx, gy + 911)) * step, y = (gy + hash2(gx + 577, gy)) * step;
      const dx = x - cam.x, dy = y - cam.y;
      if (dx * dx + dy * dy > denseR * denseR) continue;
      const m = sampleMask(x, y);
      if (!m || !okGround(m) || m.road > 40) continue;
      const cls = m.cls;
      const seed = gx * 7331 + gy * 131;
      const r2 = hash2(gx * 3 + 1, gy * 5 + 2);
      if (cls >= 245) { // forest + painted wild woods
        if (hsh < 0.5) add(r2 < 0.55 ? 'oak' : r2 < 0.93 ? 'holm' : 'pine', x, y, 0.75 + r2 * 0.55, seed);
      } else if (cls >= 215) { // scrub
        if (hsh < 0.3) add(r2 < 0.65 ? 'bush' : 'holm', x, y, 0.7 + r2 * 0.5, seed);
      } else if (cls >= 180) { // residential / industrial gardens
        if (hsh < 0.03 && m.road < 20) add(r2 < 0.35 ? 'cypress' : r2 < 0.7 ? 'oak' : 'pine', x, y, 0.8 + r2 * 0.4, seed);
      } else if (cls >= 150) { // park / cemetery
        if (hsh < 0.08) add(r2 < 0.4 ? 'cypress' : r2 < 0.75 ? 'oak' : 'pine', x, y, 0.8 + r2 * 0.4, seed);
      } else if (cls >= 30 && cls < 110 || cls < 10) { // fields, meadows, untagged: isolated oaks
        if (hsh < 0.0035) add(r2 < 0.8 ? 'oak' : 'cypress', x, y, 0.9 + r2 * 0.4, seed);
      }
    }
  }
  // olive groves on a rotated 7 m grid per 300 m block
  {
    const B = 300;
    for (let bx = Math.floor(x0 / B); bx < x1 / B; bx++) {
      for (let by = Math.floor(y0 / B); by < y1 / B; by++) {
        const ang = hash2(bx, by + 3) * Math.PI;
        const sp = 6.4 + hash2(bx + 9, by) * 1.6;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const cx = (bx + 0.5) * B, cy = (by + 0.5) * B;
        const n = Math.ceil((B * 0.75) / sp);
        for (let i = -n; i <= n; i++) {
          for (let j = -n; j <= n; j++) {
            const lx = i * sp, ly = j * sp;
            const x = cx + lx * ca - ly * sa + (hash2(i + bx * 100, j) - 0.5) * 0.8;
            const y = cy + lx * sa + ly * ca + (hash2(i, j + by * 100) - 0.5) * 0.8;
            if (Math.floor(x / B) !== bx || Math.floor(y / B) !== by) continue;
            const dx = x - cam.x, dy = y - cam.y;
            if (dx * dx + dy * dy > denseR * denseR) continue;
            const m = sampleMask(x, y);
            if (!m || m.cls < 112 || m.cls > 128 || !okGround(m) || m.road > 30) continue;
            const seed = (i * 31 + j) * 977 + bx * 13 + by;
            if (hash2(seed, 1) < 0.08) continue;
            add('olive', x, y, 0.75 + hash2(seed, 2) * 0.5, seed);
          }
        }
      }
    }
  }
  // riparian rows along rivers and streams
  for (const l of world.water.lines) {
    const p = l.p;
    const wdt = (l.w ?? world.water.lineWidths[l.k]);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i] / 10, ay = p[i + 1] / 10, bx = p[i + 2] / 10, by = p[i + 3] / 10;
      const len = Math.hypot(bx - ax, by - ay);
      if (Math.min(Math.hypot(ax - cam.x, ay - cam.y), Math.hypot(bx - cam.x, by - cam.y)) > denseR + len) continue;
      const nx = -(by - ay) / len, ny = (bx - ax) / len;
      for (let t = 0; t < len; t += 5.5) {
        for (const side of [-1, 1]) {
          const seed = Math.floor(ax * 7 + t * 13 + side * 101);
          const r = hash2(seed, 5);
          if (r > (l.k === 2 ? 0.45 : 0.75)) continue;
          const off = wdt / 2 + 2.5 + hash2(seed, 6) * 9;
          const x = ax + (bx - ax) * (t / len) + nx * off * side, y = ay + (by - ay) * (t / len) + ny * off * side;
          if (Math.hypot(x - cam.x, y - cam.y) > denseR) continue;
          const m = sampleMask(x, y);
          if (!okGround(m) || m.road > 30) continue;
          const q = hash2(seed, 7);
          add(q < 0.45 ? 'poplar' : q < 0.85 ? 'oak' : 'bush', x, y, 0.75 + hash2(seed, 8) * 0.5, seed);
        }
      }
    }
  }
  // hedgerows of shrubs with the odd oak along some field boundaries
  {
    const hr = Math.min(denseR * 1.6, 3600);
    const gi0 = Math.floor((cam.x - hr) / FIELD_CELL) - 1, gi1 = Math.ceil((cam.x + hr) / FIELD_CELL) + 1;
    const gj0 = Math.floor((cam.y - hr) / FIELD_CELL) - 1, gj1 = Math.ceil((cam.y + hr) / FIELD_CELL) + 1;
    for (let i = gi0; i < gi1; i++) {
      for (let j = gj0; j < gj1; j++) {
        const a = fieldCorner(i, j);
        for (const [b, eid] of [[fieldCorner(i + 1, j), 1], [fieldCorner(i, j + 1), 2]]) {
          const es = i * 7919 + j * 104729 + eid;
          if (hash2(es, 11) > 0.38) continue;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          if (Math.hypot(mx - cam.x, my - cam.y) > hr + len) continue;
          const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
          const gapPhase = hash2(es, 12) * 10;
          for (let t = 0; t < len; t += 2.4) {
            const seed = es * 131 + Math.floor(t * 10);
            if (Math.sin(t * 0.045 + gapPhase) > 0.72) continue; // gaps
            const wob = (hash2(seed, 13) - 0.5) * 2.2;
            const x = a[0] + (b[0] - a[0]) * (t / len) + nx * wob, y = a[1] + (b[1] - a[1]) * (t / len) + ny * wob;
            const dd = Math.hypot(x - cam.x, y - cam.y);
            if (dd > hr) continue;
            if (dd > denseR && hash2(seed, 16) > 0.45) continue; // thinner far away
            const m = sampleMask(x, y);
            if (!m || !okGround(m) || m.road > 25 || !(m.cls < 110 || m.cls === 0)) continue;
            const q = hash2(seed, 14);
            add(q < 0.08 ? 'oak' : q < 0.13 ? 'holm' : 'bush', x, y, q < 0.13 ? 0.8 + hash2(seed, 15) * 0.4 : 0.8 + hash2(seed, 15) * 0.9, seed);
          }
        }
      }
    }
  }
  // roadside cypresses / oaks along minor country roads
  const RCLS = new Set([4, 5, 9, 10]);
  for (const rd of world.roads.roads) {
    if (!RCLS.has(rd.c)) continue;
    const p = rd.p;
    const wdt = rd.w ?? world.roads.widths[rd.c];
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i] / 10, ay = p[i + 1] / 10, bx = p[i + 2] / 10, by = p[i + 3] / 10;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1 || Math.hypot(ax - cam.x, ay - cam.y) > denseR + len) continue;
      const nx = -(by - ay) / len, ny = (bx - ax) / len;
      const rowSeed = Math.floor(ax * 3 + ay * 7);
      const isRow = hash2(rowSeed, 1) < 0.08; // a cypress avenue
      for (let t = 0; t < len; t += isRow ? 7 : 11) {
        for (const side of [-1, 1]) {
          const seed = Math.floor(ax * 11 + t * 17 + side * 59);
          if (!isRow && hash2(seed, 2) > 0.1) continue;
          const off = wdt / 2 + 2.2 + hash2(seed, 3) * (isRow ? 0.4 : 4);
          const x = ax + (bx - ax) * (t / len) + nx * off * side, y = ay + (by - ay) * (t / len) + ny * off * side;
          if (Math.hypot(x - cam.x, y - cam.y) > denseR) continue;
          const m = sampleMask(x, y);
          if (!okGround(m) || m.road > 30 || m.cls >= 180) continue;
          add(isRow || hash2(seed, 4) < 0.4 ? 'cypress' : 'oak', x, y, 0.8 + hash2(seed, 5) * 0.35, seed);
        }
      }
    }
  }
  return out;
}

const LOD_DIST = [140, 650];
export function buildTreeMeshes(instances, material, shadowR) {
  const group = new THREE.Group();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const qLean = new THREE.Quaternion(), leanAx = new THREE.Vector3();
  const depthMat = makeTreeDepthMaterial();
  let total = 0;
  for (const [name, list] of Object.entries(instances)) {
    if (!list.length) continue;
    const sp = SPECIES[name];
    for (let lod = 0; lod < 3; lod++) {
      const sel = list.filter((t) => (lod === 0 ? t[6] < LOD_DIST[0] : lod === 1 ? t[6] >= LOD_DIST[0] && t[6] < LOD_DIST[1] : t[6] >= LOD_DIST[1]));
      if (!sel.length) continue;
      // shape variants per LOD for variety
      const NV = lod === 2 ? 2 : 4;
      for (let variant = 0; variant < NV; variant++) {
        const vs = sel.filter((t) => (Math.floor(t[4] * 1000) % NV) === variant);
        if (!vs.length) continue;
        const geo = buildTree(sp, lod, (name.length * 17 + variant * 5 + 1));
        const mesh = new THREE.InstancedMesh(geo, material, vs.length);
        mesh.customDepthMaterial = depthMat;
        vs.forEach((t, i) => {
          p.set(t[0], t[2], -t[1]);
          // heading + a small random lean
          const lr = ((i * 2246822519) >>> 0) / 4294967296, la = ((i * 3266489917) >>> 0) / 4294967296 * Math.PI * 2;
          q.setFromAxisAngle(up, t[4]).premultiply(qLean.setFromAxisAngle(leanAx.set(Math.cos(la), 0, Math.sin(la)), (lr - 0.5) * 0.12));
          const sc = t[3];
          s.set(sc * (0.9 + 0.2 * ((i * 7) % 5) / 5), sc, sc * (0.9 + 0.2 * ((i * 3) % 5) / 5));
          m4.compose(p, q, s);
          mesh.setMatrixAt(i, m4);
          // late-summer variety: some yellower / olive, some darker blue-green
          const yel = ((i * 2654435761) >>> 0) / 4294967296;
          const hueS = (yel - 0.5) * 2;
          col.setRGB(t[5] * (1 + hueS * 0.2), t[5] * (1 + hueS * 0.06), t[5] * (1 - hueS * 0.22));
          mesh.setColorAt(i, col);
        });
        mesh.castShadow = lod < 2;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        group.add(mesh);
        total += vs.length;
      }
    }
  }
  group.userData.total = total;
  return group;
}
