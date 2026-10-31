#!/usr/bin/env node
/**
 * Generates public/models/velo-rider.glb — the stylized road rider the world
 * renderer (src/renderers/three/Rider.tsx) draws. Deterministic: same three
 * version → byte-identical file.
 *
 *   node scripts/gen-rider-glb.mjs
 *
 * Contract (also in public/models/CONTRACT.md, "velo-rider.glb"):
 *   metres, +Y up, +X forward, +Z to the rider's right; origin on the ground
 *   midway between the tyre contact patches. Wheel plane XY, axles along Z.
 *   Named nodes (pivot = node origin): wheelFront / wheelRear (spin about Z),
 *   crank (about Z, at the bottom bracket), thighL/R (hip), shinL/R (knee),
 *   footL/R (ankle) — leg segments hang along local −Y — plus static frame
 *   and riderBody. Named materials, recoloured at runtime from AvatarColors:
 *   frame, wheel, kit, skin, helmet, accent; fixed: bib, tyre, metal, sock.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// GLTFExporter's binary path reads its Blob through FileReader (browser only).
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
      this.onloadend?.();
    });
  }
};

// ---------------------------------------------------------------------------
// Geometry (exported so Rider.tsx and its tests share the numbers)
// ---------------------------------------------------------------------------
export const RIG = {
  wheelRadius: 0.34,
  rearAxle: [-0.5, 0.34],
  frontAxle: [0.5, 0.34],
  bb: [-0.09, 0.27],
  crankLength: 0.1725,
  hip: [-0.27, 1.05],
  hipHalfWidth: 0.09,
  thigh: 0.46,
  shin: 0.46,
  /** Ankle sits this far above the pedal axle. */
  ankleAbovePedal: 0.07,
};

const mat = (name, color, roughness, metalness = 0) => {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  m.name = name;
  return m;
};
const MATERIALS = {
  frame: mat('frame', '#e2e8f0', 0.35, 0.55),
  wheel: mat('wheel', '#0b1220', 0.45, 0.35),
  tyre: mat('tyre', '#16171a', 0.85),
  metal: mat('metal', '#9aa3ad', 0.3, 0.9),
  kit: mat('kit', '#22d3ee', 0.7),
  bib: mat('bib', '#15181d', 0.75),
  skin: mat('skin', '#d8a877', 0.8),
  sock: mat('sock', '#eef0f2', 0.85),
  helmet: mat('helmet', '#0ea5e9', 0.35, 0.1),
  accent: mat('accent', '#f59e0b', 0.5, 0.1),
};

const v3 = (x, y, z = 0) => new THREE.Vector3(x, y, z);

/** Cylinder (or tapered cone) from a to b. */
function tube(a, b, r0, r1 = r0, seg = 10) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Capsule from a to b with radius r, optionally squashed across (sx, sz). */
function limb(a, b, r, { sx = 1, sz = 1, seg = 10 } = {}) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CapsuleGeometry(r, Math.max(0.001, len), 4, seg);
  g.scale(sx, 1, sz);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), dir.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

function ellipsoid(c, rx, ry, rz, seg = 18) {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7));
  g.scale(rx, ry, rz);
  g.translate(c.x, c.y, c.z);
  return g;
}

function box(c, sx, sy, sz, rotZ = 0) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(c.x, c.y, c.z);
  return g;
}

function clean(g) {
  // mergeGeometries needs identical attribute sets.
  const out = g.index ? g : g.toNonIndexed();
  for (const k of Object.keys(out.attributes)) if (!['position', 'normal', 'uv'].includes(k)) out.deleteAttribute(k);
  return out;
}

/** One node holding one mesh per material. */
function node(name, parts, origin = v3(0, 0, 0)) {
  const group = new THREE.Group();
  group.name = name;
  group.position.copy(origin);
  const byMat = new Map();
  for (const [matKey, geo] of parts) {
    if (!byMat.has(matKey)) byMat.set(matKey, []);
    byMat.get(matKey).push(clean(geo));
  }
  for (const [matKey, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    // Positions were authored in rig space; make them local to the pivot.
    merged.translate(-origin.x, -origin.y, -origin.z);
    const mesh = new THREE.Mesh(merged, MATERIALS[matKey]);
    mesh.name = `${name}-${matKey}`;
    group.add(mesh);
  }
  return group;
}

function wheel(name, axle) {
  const [ax, ay] = axle;
  const c = v3(ax, ay, 0);
  const parts = [];
  const tyreG = new THREE.TorusGeometry(RIG.wheelRadius - 0.014, 0.014, 10, 64);
  tyreG.translate(ax, ay, 0);
  parts.push(['tyre', tyreG]);
  const rim = new THREE.TorusGeometry(RIG.wheelRadius - 0.045, 0.022, 8, 64);
  rim.scale(1, 1, 0.55);
  rim.translate(ax, ay, 0);
  parts.push(['wheel', rim]);
  parts.push(['metal', tube(v3(ax, ay, -0.05), v3(ax, ay, 0.05), 0.018, 0.018, 12)]);
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const side = i % 2 ? 0.03 : -0.03;
    const end = v3(ax + Math.cos(a) * (RIG.wheelRadius - 0.06), ay + Math.sin(a) * (RIG.wheelRadius - 0.06), 0);
    parts.push(['metal', tube(v3(ax, ay, side), end, 0.0014, 0.0014, 4)]);
  }
  return node(name, parts, c);
}

function build() {
  const root = new THREE.Group();
  root.name = 'velo-rider';

  const R = v3(...RIG.rearAxle);
  const F = v3(...RIG.frontAxle);
  const BB = v3(...RIG.bb);
  const seatTop = v3(-0.246, 0.797);
  const saddle = v3(-0.297, 0.975);
  const headTop = v3(0.37, 0.86);
  const headBottom = v3(0.41, 0.7);
  const stemEnd = v3(0.48, 0.9);

  // ---- frame (static) ----
  const frameParts = [
    ['frame', tube(BB, seatTop, 0.017)],
    ['frame', tube(seatTop, headTop, 0.015)],
    ['frame', tube(BB, headBottom, 0.022, 0.02)],
    ['frame', tube(headBottom, headTop, 0.022)],
    ['frame', tube(v3(BB.x, BB.y, 0.02), v3(R.x, R.y, 0.055), 0.011, 0.008)],
    ['frame', tube(v3(BB.x, BB.y, -0.02), v3(R.x, R.y, -0.055), 0.011, 0.008)],
    ['frame', tube(v3(seatTop.x, seatTop.y, 0.015), v3(R.x, R.y, 0.055), 0.009, 0.007)],
    ['frame', tube(v3(seatTop.x, seatTop.y, -0.015), v3(R.x, R.y, -0.055), 0.009, 0.007)],
    ['frame', tube(v3(headBottom.x, headBottom.y, 0.03), v3(F.x, F.y, 0.05), 0.014, 0.008)],
    ['frame', tube(v3(headBottom.x, headBottom.y, -0.03), v3(F.x, F.y, -0.05), 0.014, 0.008)],
    ['frame', box(v3(BB.x, BB.y, 0), 0.06, 0.06, 0.08)],
    ['metal', tube(seatTop, v3(saddle.x + 0.01, saddle.y - 0.03), 0.0135)],
    ['accent', box(v3(saddle.x + 0.02, saddle.y, 0), 0.27, 0.035, 0.1)],
    ['metal', tube(headTop, v3(headTop.x + 0.005, headTop.y + 0.03), 0.017)],
    ['metal', tube(v3(headTop.x + 0.005, headTop.y + 0.03), stemEnd, 0.016)],
    // Bars: tops across, then hoods and drops on each side.
    ['frame', tube(v3(stemEnd.x, stemEnd.y, -0.2), v3(stemEnd.x, stemEnd.y, 0.2), 0.013)],
  ];
  for (const z of [-0.2, 0.2]) {
    const top = v3(stemEnd.x, stemEnd.y, z);
    const hood = v3(stemEnd.x + 0.07, stemEnd.y + 0.005, z);
    const drop0 = v3(stemEnd.x + 0.1, stemEnd.y - 0.06, z);
    const drop1 = v3(stemEnd.x + 0.06, stemEnd.y - 0.13, z);
    const drop2 = v3(stemEnd.x - 0.04, stemEnd.y - 0.13, z);
    frameParts.push(['frame', tube(top, hood, 0.013)]);
    frameParts.push(['accent', limb(hood, v3(hood.x + 0.035, hood.y + 0.03, z), 0.017)]);
    frameParts.push(['frame', tube(hood, drop0, 0.013)]);
    frameParts.push(['frame', tube(drop0, drop1, 0.013)]);
    frameParts.push(['frame', tube(drop1, drop2, 0.013)]);
  }
  root.add(node('frame', frameParts));

  root.add(wheel('wheelRear', RIG.rearAxle));
  root.add(wheel('wheelFront', RIG.frontAxle));

  // ---- crank (spins about Z at the BB): chainring + both arms ----
  const ring = new THREE.TorusGeometry(0.1, 0.006, 6, 48);
  ring.translate(BB.x, BB.y, 0.05);
  const ringDisc = new THREE.CylinderGeometry(0.095, 0.095, 0.004, 32);
  ringDisc.rotateX(Math.PI / 2);
  ringDisc.translate(BB.x, BB.y, 0.05);
  const L = RIG.crankLength;
  root.add(
    node(
      'crank',
      [
        ['metal', ring],
        ['metal', ringDisc],
        // Right arm points +X at angle 0, left arm opposite.
        ['metal', tube(v3(BB.x, BB.y, 0.065), v3(BB.x + L, BB.y, 0.075), 0.011, 0.008)],
        ['metal', tube(v3(BB.x, BB.y, -0.065), v3(BB.x - L, BB.y, -0.075), 0.011, 0.008)],
        ['metal', tube(v3(BB.x, BB.y, -0.075), v3(BB.x, BB.y, 0.075), 0.012)],
      ],
      BB,
    ),
  );

  // ---- rider body (static: torso, arms, head) ----
  const pelvis = v3(RIG.hip[0] + 0.02, RIG.hip[1] + 0.02);
  const shoulder = v3(0.2, 1.37);
  const neck = v3(0.27, 1.43);
  const headC = v3(0.32, 1.5);
  const bodyParts = [
    ['bib', ellipsoid(v3(pelvis.x, pelvis.y, 0), 0.13, 0.1, 0.15)],
    ['kit', limb(pelvis, shoulder, 0.135, { sz: 1.35, seg: 14 })],
    ['skin', limb(shoulder, neck, 0.05)],
    ['skin', ellipsoid(headC, 0.105, 0.115, 0.095)],
    ['helmet', ellipsoid(v3(headC.x - 0.02, headC.y + 0.045, 0), 0.155, 0.1, 0.115)],
    ['helmet', limb(v3(headC.x - 0.1, headC.y + 0.04), v3(headC.x - 0.19, headC.y + 0.01), 0.035, { sz: 2.2 })],
    ['bib', box(v3(headC.x + 0.085, headC.y + 0.01, 0), 0.04, 0.035, 0.15)],
  ];
  for (const z of [-1, 1]) {
    const sh = v3(shoulder.x - 0.02, shoulder.y - 0.02, z * 0.185);
    const elbow = v3(0.37, 1.13, z * 0.205);
    const hand = v3(stemEnd.x + 0.085, stemEnd.y + 0.04, z * 0.2);
    const sleeveEnd = v3(sh.x + (elbow.x - sh.x) * 0.55, sh.y + (elbow.y - sh.y) * 0.55, z * 0.195);
    bodyParts.push(['kit', limb(sh, sleeveEnd, 0.048)]);
    bodyParts.push(['skin', limb(sleeveEnd, elbow, 0.04)]);
    bodyParts.push(['skin', limb(elbow, hand, 0.034)]);
    bodyParts.push(['bib', ellipsoid(hand, 0.04, 0.035, 0.03)]);
  }
  root.add(node('riderBody', bodyParts));

  // ---- legs: segments hang along local −Y from their pivots ----
  for (const [side, z] of [
    ['L', -RIG.hipHalfWidth],
    ['R', RIG.hipHalfWidth],
  ]) {
    const hip = v3(0, 0, z);
    const thighParts = [
      ['bib', limb(hip, v3(0, -RIG.thigh * 0.72, z), 0.072, { sz: 0.95 })],
      ['skin', limb(v3(0, -RIG.thigh * 0.68, z), v3(0, -RIG.thigh, z), 0.052)],
    ];
    const shinParts = [
      ['skin', limb(v3(0, 0, z), v3(0, -RIG.shin * 0.78, z), 0.05)],
      ['sock', tube(v3(0, -RIG.shin * 0.8, z), v3(0, -RIG.shin, z), 0.039)],
    ];
    const footParts = [
      ['accent', box(v3(0.055, -0.035, z), 0.25, 0.07, 0.09)],
      ['bib', box(v3(0.06, -0.075, z), 0.24, 0.012, 0.085)],
    ];
    // Authored around the origin; node() subtracts the pivot, so pass zero.
    const thighNode = node(`thigh${side}`, thighParts);
    thighNode.position.set(RIG.hip[0], RIG.hip[1], 0);
    const shinNode = node(`shin${side}`, shinParts);
    const footNode = node(`foot${side}`, footParts);
    root.add(thighNode, shinNode, footNode);
  }
  return root;
}

async function main() {
  const scene = new THREE.Scene();
  scene.add(build());
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(scene, { binary: true, onlyVisible: true });
  const out = fileURLToPath(new URL('../public/models/velo-rider.glb', import.meta.url));
  writeFileSync(out, Buffer.from(glb));
  console.log(`wrote ${out} (${glb.byteLength} bytes)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
