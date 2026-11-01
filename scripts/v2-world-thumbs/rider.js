// Stand-in road cyclist + bike built from primitives (correct proportions,
// matte dark kit, one warm accent). Local frame: +x forward, +y up, +z right.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial } from './atmosphere.js';

const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);

function tube(a, b, r0, r1 = r0, seg = 12, caps = true) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()));
  g.translate(a.x, a.y, a.z);
  const parts = [g];
  if (caps) {
    const s0 = new THREE.SphereGeometry(r0, seg, 8); s0.translate(a.x, a.y, a.z); parts.push(s0);
    const s1 = new THREE.SphereGeometry(r1, seg, 8); s1.translate(b.x, b.y, b.z); parts.push(s1);
  }
  return parts;
}

function ellipsoid(c, rx, ry, rz, rot = null, seg = 20) {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7));
  g.scale(rx, ry, rz);
  if (rot) g.applyQuaternion(rot);
  g.translate(c.x, c.y, c.z);
  return g;
}

function clean(gs) {
  return gs.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    return n;
  });
}

/** Two-bone IK in the plane containing hip, ankle and a pole direction. */
function knee(hip, ankle, l1, l2, pole) {
  const d = ankle.clone().sub(hip);
  const L = Math.min(d.length(), l1 + l2 - 1e-3);
  const dir = d.clone().normalize();
  const a = (l1 * l1 - l2 * l2 + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const side = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  return hip.clone().add(dir.multiplyScalar(a)).add(side.multiplyScalar(h));
}

export function buildRider(U, envMap, opts = {}) {
  const crank = opts.crankDeg ?? 75;
  // Physical materials: fabric sheen on the kit, clearcoat on frame/helmet/rims,
  // plus a sun rim light so a backlit rider gets a bright silhouette edge.
  const RIM = `{
      vec3 vdW = normalize(vWPos - cameraPosition);
      float back = pow(max(dot(vdW, uSunDir), 0.0), 1.5);
      float fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
      gl_FragColor.rgb += gSunLit * fr * (0.2 + 2.6 * back) * RIM_K;
    }`;
  const mat = (hex, rough, metal = 0, extra = {}, rimK = 0.35) => patchMaterial(new THREE.MeshPhysicalMaterial({ color: hex, roughness: rough, metalness: metal, envMap, envMapIntensity: 0.8, ...extra }), U,
    { key: 'rider' + rimK, beforeAtmo: RIM.replace('RIM_K', rimK.toFixed(3)) });
  const fabric = { sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color('#8d8f96') };
  const gloss = { clearcoat: 1, clearcoatRoughness: 0.12 };
  const M = {
    frame: mat('#1a1c20', 0.3, 0.2, gloss, 0.5),
    accentFrame: mat('#c95a26', 0.3, 0.05, gloss, 0.5),
    rubber: mat('#161515', 0.8, 0, {}, 0.25),
    rim: mat('#141518', 0.22, 0.35, gloss, 0.6),
    alloy: mat('#9a9ca0', 0.28, 0.9, {}, 0.4),
    kit: mat('#23262d', 0.72, 0, fabric, 0.45),
    kitDark: mat('#121317', 0.75, 0, fabric, 0.4),
    accent: mat('#d8622a', 0.65, 0, { ...fabric, sheenColor: new THREE.Color('#ffb48a') }, 0.45),
    skin: mat('#b07a5a', 0.5, 0, { sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color('#ffb28c') }, 0.7),
    helmet: mat('#e8e6e1', 0.35, 0, gloss, 0.5),
    shoe: mat('#1b1c1f', 0.4, 0, gloss, 0.4),
    sock: mat('#e2dfd8', 0.85, 0, fabric, 0.5),
    lens: mat('#0d0f12', 0.08, 0.7, {}, 0.3),
  };
  const groups = new Map();
  const add = (m, gs) => { if (!groups.has(m)) groups.set(m, []); groups.get(m).push(...(Array.isArray(gs) ? gs : [gs])); };

  // ---------------- bike ----------------
  const BB = V(0, 0.27), RA = V(-0.405, 0.335), FA = V(0.585, 0.335);
  const ST = V(-0.175, 0.80), HT = V(0.445, 0.845), HB = V(0.485, 0.705);
  for (const [axle] of [[RA], [FA]]) {
    const tyre = new THREE.TorusGeometry(0.322, 0.0145, 10, 72); tyre.translate(axle.x, axle.y, 0); add(M.rubber, tyre);
    const rim = new THREE.TorusGeometry(0.285, 0.024, 8, 72); rim.scale(1, 1, 0.55); rim.translate(axle.x, axle.y, 0); add(M.rim, rim);
    const hub = new THREE.CylinderGeometry(0.022, 0.022, 0.1, 12); hub.rotateX(Math.PI / 2); hub.translate(axle.x, axle.y, 0); add(M.alloy, hub);
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const z = i % 2 ? 0.035 : -0.035;
      add(M.alloy, tube(V(axle.x, axle.y, z), V(axle.x + Math.cos(a) * 0.27, axle.y + Math.sin(a) * 0.27, 0), 0.0012, 0.0012, 4, false));
    }
  }
  const fr = (a, b, r) => add(M.frame, tube(a, b, r, r, 12));
  fr(BB, ST, 0.017); fr(ST, HT, 0.018); fr(BB, HB, 0.024); fr(HB, HT, 0.022);
  for (const z of [-0.055, 0.055]) {
    fr(V(BB.x, BB.y, z * 0.6), V(RA.x, RA.y, z), 0.011);
    fr(V(ST.x, ST.y - 0.03, z * 0.3), V(RA.x, RA.y, z), 0.009);
    fr(V(HB.x, HB.y, z * 0.7), V(FA.x, FA.y, z), 0.012);
  }
  add(M.accentFrame, tube(V(0.05, 0.37), V(0.21, 0.56), 0.0245, 0.0245, 12, false)); // accent on the down tube
  const SAD = V(-0.215, 0.965);
  add(M.frame, tube(ST, V(-0.21, 0.94), 0.0135));
  add(M.kitDark, ellipsoid(SAD, 0.135, 0.022, 0.06));
  const STEM = V(0.545, 0.885);
  add(M.frame, tube(HT, STEM, 0.016));
  add(M.frame, tube(V(STEM.x, STEM.y, -0.21), V(STEM.x, STEM.y, 0.21), 0.0125));
  for (const z of [-0.205, 0.205]) {
    // drops: forward, down and back
    const p1 = V(STEM.x + 0.07, STEM.y - 0.01, z), p2 = V(STEM.x + 0.09, STEM.y - 0.09, z), p3 = V(STEM.x + 0.03, STEM.y - 0.15, z);
    add(M.frame, tube(V(STEM.x, STEM.y, z), p1, 0.0125)); add(M.frame, tube(p1, p2, 0.0125)); add(M.frame, tube(p2, p3, 0.0125));
    add(M.kitDark, ellipsoid(V(STEM.x + 0.085, STEM.y + 0.025, z), 0.04, 0.03, 0.017)); // hoods
  }
  // crankset
  const ring = new THREE.CylinderGeometry(0.105, 0.105, 0.006, 40); ring.rotateX(Math.PI / 2); ring.translate(BB.x, BB.y, 0.07); add(M.alloy, ring);
  const th = (crank * Math.PI) / 180;
  const pedR = V(BB.x + Math.cos(th) * 0.17, BB.y + Math.sin(th) * 0.17, 0.105);
  const pedL = V(BB.x - Math.cos(th) * 0.17, BB.y - Math.sin(th) * 0.17, -0.105);
  add(M.frame, tube(V(BB.x, BB.y, 0.08), pedR, 0.011)); add(M.frame, tube(V(BB.x, BB.y, -0.08), pedL, 0.011));
  // chain line hint
  add(M.alloy, tube(V(BB.x, BB.y + 0.1, 0.07), V(RA.x, RA.y + 0.035, 0.07), 0.004, 0.004, 4, false));
  add(M.alloy, tube(V(BB.x, BB.y - 0.1, 0.07), V(RA.x, RA.y - 0.035, 0.07), 0.004, 0.004, 4, false));

  // ---------------- rider ----------------
  const HIP = V(-0.17, 1.02);
  const SH = V(0.27, 1.385);
  const torsoDir = SH.clone().sub(HIP).normalize();
  const tq = new THREE.Quaternion().setFromUnitVectors(V(1, 0, 0), torsoDir);
  // pelvis / bibs
  add(M.kitDark, ellipsoid(V(-0.16, 1.035), 0.15, 0.115, 0.165, tq));
  // abdomen + chest (jersey), shoulders
  add(M.kit, ellipsoid(HIP.clone().lerp(SH, 0.38), 0.21, 0.115, 0.158, tq));
  add(M.kit, ellipsoid(HIP.clone().lerp(SH, 0.74), 0.22, 0.13, 0.19, tq));
  for (const z of [-1, 1]) add(M.kit, ellipsoid(V(SH.x - 0.01, SH.y - 0.01, z * 0.165), 0.075, 0.07, 0.07));
  // accent side panels on the jersey
  for (const z of [-1, 1]) add(M.accent, ellipsoid(HIP.clone().lerp(SH, 0.55).add(V(0, -0.02, z * 0.142)), 0.17, 0.06, 0.03, tq));
  // neck + head + helmet + glasses
  const HEAD = V(0.43, 1.505);
  add(M.skin, tube(V(SH.x + 0.03, SH.y + 0.02), V(HEAD.x - 0.045, HEAD.y - 0.06), 0.048));
  add(M.skin, ellipsoid(HEAD, 0.1, 0.112, 0.08));
  const hq = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -0.25);
  add(M.helmet, ellipsoid(V(HEAD.x - 0.02, HEAD.y + 0.045), 0.15, 0.1, 0.112, hq));
  add(M.accent, ellipsoid(V(HEAD.x - 0.025, HEAD.y + 0.072), 0.13, 0.075, 0.03, hq));
  add(M.lens, ellipsoid(V(HEAD.x + 0.075, HEAD.y + 0.005), 0.03, 0.022, 0.085));
  // arms: shoulder -> elbow -> hands on the hoods
  for (const z of [-1, 1]) {
    const s = V(SH.x, SH.y - 0.02, z * 0.175);
    const hand = V(STEM.x + 0.075, STEM.y + 0.04, z * 0.205);
    const el = knee(s, hand, 0.3, 0.285, V(-0.4, -0.5, z * 0.8).normalize());
    add(M.kit, tube(s, s.clone().lerp(el, 0.55), 0.05, 0.044));
    add(M.accent, tube(s.clone().lerp(el, 0.55), s.clone().lerp(el, 0.62), 0.045, 0.044, 12, false));
    add(M.skin, tube(s.clone().lerp(el, 0.62), el, 0.041, 0.038));
    add(M.skin, tube(el, hand.clone().lerp(el, 0.18), 0.037, 0.03));
    add(M.kitDark, ellipsoid(hand, 0.045, 0.03, 0.035)); // glove
  }
  // legs: hip -> knee -> ankle -> shoe on pedal
  for (const [ped, z] of [[pedR, 1], [pedL, -1]]) {
    const hip = V(HIP.x, HIP.y, z * 0.095);
    const pedal = V(ped.x, ped.y, z * 0.1);
    const ankle = pedal.clone().add(V(-0.07, 0.075, 0));
    const kn = knee(hip, ankle, 0.445, 0.43, V(1, 0.35, 0).normalize());
    add(M.kitDark, tube(hip, hip.clone().lerp(kn, 0.8), 0.078, 0.06));
    add(M.skin, tube(hip.clone().lerp(kn, 0.8), kn, 0.058, 0.052));
    add(M.skin, tube(kn, kn.clone().lerp(ankle, 0.72), 0.052, 0.04));
    add(M.sock, tube(kn.clone().lerp(ankle, 0.72), ankle, 0.037, 0.033));
    // shoe pointing forward / slightly down along the pedal
    const toe = pedal.clone().add(V(0.12, -0.01, 0));
    const heel = pedal.clone().add(V(-0.12, 0.05, 0));
    add(M.shoe, tube(heel, toe, 0.04, 0.032));
  }

  const group = new THREE.Group();
  for (const [m, gs] of groups) {
    const mesh = new THREE.Mesh(mergeGeometries(clean(gs)), m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
