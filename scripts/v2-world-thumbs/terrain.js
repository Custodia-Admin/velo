// Terrain: full-resolution heightfield mesh + a seamless procedural apron
// beyond the world edge (so horizons are never cut off), and the ground
// material (landcover texture cascade + procedural detail + water).
import * as THREE from 'three';
import { fbm } from './world.js';
import { patchMaterial } from './atmosphere.js';

/**
 * Lighting normals from a blurred copy of the heightfield. The 13 m DEM has
 * ~0.5-1 m noise, i.e. +-4 deg facet tilt; at a 4 deg golden-hour sun that
 * turns N.L into stripes across every field. Blurring (~2 cells) keeps the
 * hills and kills the noise. Cached on the heightfield.
 */
export function smoothNormalField(hf) {
  if (hf._sn) return hf._sn;
  const { cols, rows, cell } = hf;
  let a = Float32Array.from(hf.h), b = new Float32Array(a.length);
  const R = 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let acc = 0, n = 0;
        for (let k = -R; k <= R; k++) { const cc = Math.max(0, Math.min(cols - 1, c + k)); acc += a[r * cols + cc]; n++; }
        b[r * cols + c] = acc / n;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let acc = 0, n = 0;
        for (let k = -R; k <= R; k++) { const rr = Math.max(0, Math.min(rows - 1, r + k)); acc += b[rr * cols + c]; n++; }
        a[r * cols + c] = acc / n;
      }
    }
  }
  const node = (c, r) => a[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))];
  const nor = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const dhdx = (node(c + 1, r) - node(c - 1, r)) / (2 * cell);
      const dhdz = (node(c, r + 1) - node(c, r - 1)) / (2 * cell);
      const l = Math.hypot(dhdx, 1, dhdz);
      nor[i * 3] = -dhdx / l; nor[i * 3 + 1] = 1 / l; nor[i * 3 + 2] = -dhdz / l;
    }
  }
  hf._sn = nor;
  return nor;
}

export function buildTerrainGeometry(hf) {
  const { cols, rows, cell } = hf;
  const n = cols * rows;
  const sn = smoothNormalField(hf);
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const h = hf.h[i];
      pos[i * 3] = hf.xMin + c * cell;
      pos[i * 3 + 1] = h;
      pos[i * 3 + 2] = -(hf.yMax - r * cell);
      nor[i * 3] = sn[i * 3]; nor[i * 3 + 1] = sn[i * 3 + 1]; nor[i * 3 + 2] = sn[i * 3 + 2];
    }
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      idx[k++] = a; idx[k++] = a + cols; idx[k++] = a + 1;
      idx[k++] = a + 1; idx[k++] = a + cols; idx[k++] = a + cols + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3((hf.xMin + hf.xMax) / 2, 400, -(hf.yMin + hf.yMax) / 2), 40000);
  return g;
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Plausible surroundings outside the baked extent (Subasio to the east, valleys south). */
function apronHeight(x, y, edgeH, d) {
  const regional = 300 + 260 * fbm(x * 0.00012 + 3.3, y * 0.00012 - 1.7, 4);
  let h = edgeH + (regional - edgeH) * smooth(0, 7000, d);
  const ridge = 1 - Math.abs(2 * fbm(x * 0.00045, y * 0.00045, 5) - 1);
  h += (ridge * ridge * 260 + fbm(x * 0.002, y * 0.002, 4) * 60 - 60) * smooth(0, 2500, d);
  // Monte Subasio massif east of Assisi
  const sx = (x - 23800) / 3600, sy = (y + 4600) / 5200;
  h += 900 * Math.exp(-(sx * sx + sy * sy) / 2) * smooth(0, 2600, d);
  // Apennine wall far to the east and north-east
  h += 500 * smooth(26000, 42000, x) * smooth(0, 4000, d);
  // the Tiber and Valle Umbra valleys continue south, flat
  const tib = Math.exp(-Math.pow((x - 3500) / 2600, 2)) * smooth(-8500, -11000, y);
  const vu = Math.exp(-Math.pow((x - 17000 + (y + 8500) * 0.45) / 4200, 2)) * smooth(-7500, -10500, y);
  h = h * (1 - Math.max(tib, vu)) + (edgeH < 260 ? edgeH : 210) * Math.max(tib, vu);
  return h;
}

export function buildApronGeometry(hf) {
  const { cols, rows, cell } = hf;
  const per = [];
  for (let c = 0; c < cols; c++) per.push([c, 0]);
  for (let r = 1; r < rows; r++) per.push([cols - 1, r]);
  for (let c = cols - 2; c >= 0; c--) per.push([c, rows - 1]);
  for (let r = rows - 2; r >= 1; r--) per.push([0, r]);
  const N = per.length;
  const W = hf.xMax - hf.xMin, H = hf.yMax - hf.yMin;
  const ringD = [0];
  let d = 0, step = cell;
  while (d < 110000) { d += step; step *= 1.075; ringD.push(d); }
  const R = ringD.length;
  const pos = new Float32Array(N * R * 3);
  // smoothed edge heights so far rings don't copy every bump of the edge
  const edgeH = per.map(([c, r]) => hf.node(c, r));
  for (let k = 0; k < R; k++) {
    const dk = ringD[k];
    const win = Math.min(400, Math.floor(dk / cell / 3));
    // prefix sums for box blur of edge heights (wrapping)
    let sm = edgeH;
    if (win > 0) {
      sm = new Float32Array(N);
      let acc = 0;
      for (let j = -win; j <= win; j++) acc += edgeH[(j + N) % N];
      for (let i = 0; i < N; i++) {
        sm[i] = acc / (2 * win + 1);
        acc += edgeH[(i + win + 1) % N] - edgeH[(i - win + N) % N];
      }
    }
    for (let i = 0; i < N; i++) {
      const [c, r] = per[i];
      const ex = hf.xMin + c * cell, ey = hf.yMax - r * cell;
      const x = hf.xMin - dk + ((ex - hf.xMin) / W) * (W + 2 * dk);
      const y = hf.yMin - dk + ((ey - hf.yMin) / H) * (H + 2 * dk);
      const h = k === 0 ? edgeH[i] : apronHeight(x, y, sm[i], dk);
      const o = (k * N + i) * 3;
      pos[o] = x; pos[o + 1] = h; pos[o + 2] = -y;
    }
  }
  const idx = new Uint32Array((R - 1) * N * 6);
  let q = 0;
  for (let k = 0; k < R - 1; k++) {
    for (let i = 0; i < N; i++) {
      const a = k * N + i, b = k * N + ((i + 1) % N), c2 = (k + 1) * N + i, d2 = (k + 1) * N + ((i + 1) % N);
      idx[q++] = a; idx[q++] = b; idx[q++] = c2;
      idx[q++] = b; idx[q++] = d2; idx[q++] = c2;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // fix winding so faces point up
  const p0 = new THREE.Vector3().fromArray(pos, idx[0] * 3), p1 = new THREE.Vector3().fromArray(pos, idx[1] * 3), p2 = new THREE.Vector3().fromArray(pos, idx[2] * 3);
  const nrm = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
  if (nrm.y < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.computeVertexNormals();
  // ring 0 shares the terrain's edge normals (seamless shading)
  const nor = g.attributes.normal.array;
  const sn = smoothNormalField(hf);
  for (let i = 0; i < N; i++) {
    const [c, r] = per[i];
    const j = (r * cols + c) * 3;
    nor[i * 3] = sn[j]; nor[i * 3 + 1] = sn[j + 1]; nor[i * 3 + 2] = sn[j + 2];
  }
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

const NOISE_GLSL = /* glsl */ `
uint pcgH(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float hashI(vec2 i) { ivec2 p = ivec2(i); return float(pcgH(uint(p.x) * 1597334677u ^ pcgH(uint(p.y) + 7919u))) / 4294967295.0; }
float vnoiseG(vec2 p) {
  vec2 i = floor(p); vec2 f = p - i; vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hashI(i), b = hashI(i + vec2(1, 0)), c = hashI(i + vec2(0, 1)), d = hashI(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// fade an octave out when it is smaller than ~2 pixels
float octF(float scaleM, float pxM) { return 1.0 - smoothstep(scaleM * 0.25, scaleM * 0.7, pxM); }
float fbmG(vec2 p, int oct) { float s = 0.0, a = 0.5; for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * vnoiseG(p); p = p * 2.03 + vec2(13.1, 7.7); a *= 0.5; } return s; }
vec3 sRGB(vec3 c) { return pow(c, vec3(2.2)); }
`;

export function makeGroundMaterial(U, levels, envMap) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, envMap, envMapIntensity: 1 });
  const lu = {};
  levels.forEach((L, i) => {
    lu[`uTex${i}`] = { value: L.tex };
    lu[`uMask${i}`] = { value: L.maskTex };
    lu[`uAux${i}`] = { value: L.auxTex };
    lu[`uB${i}`] = { value: new THREE.Vector4(L.B.x0, L.B.y0, 1 / (L.B.x1 - L.B.x0), 1 / (L.B.y1 - L.B.y0)) };
  });
  const nL = levels.length;
  let sampleCode = '';
  for (let i = 0; i < nL; i++) {
    sampleCode += `
    {
      vec2 uv = (wp - uB${i}.xy) * uB${i}.zw;
      vec2 e = min(uv, 1.0 - uv);
      float w = ${i === 0 ? 'step(0.0, min(e.x, e.y))' : 'smoothstep(0.0, 0.06, min(e.x, e.y))'};
      if (w > 0.0) {
        gCol = mix(gCol, texture2D(uTex${i}, uv).rgb, w);
        gMask = mix(gMask, texture2D(uMask${i}, uv).rgb, w);
        if (w > 0.5) gAux = texture2D(uAux${i}, uv).rgb;
        inWorld = max(inWorld, w);
      }
    }`;
  }
  return patchMaterial(mat, U, {
    key: 'ground' + nL,
    uniforms: lu,
    vertexPars: 'varying vec3 vWN;',
    vertexMain: 'vWN = normal;',
    fragmentPars: `varying vec3 vWN;
      ${levels.map((_, i) => `uniform sampler2D uTex${i}; uniform sampler2D uMask${i}; uniform sampler2D uAux${i}; uniform vec4 uB${i};`).join('\n')}
      ${NOISE_GLSL}
      float gWater = 0.0; float gRoad = 0.0; float gForest = 0.0; vec2 gWp;`,
    fragmentReplace: [
      ['#include <map_fragment>', `
      vec2 wp = vec2(vWPos.x, -vWPos.z);
      gWp = wp;
      vec3 wn = normalize(vWN);
      float slope = 1.0 - wn.y;
      float pxM = length(fwidth(wp));
      vec3 gCol = vec3(0.0); vec3 gMask = vec3(0.0); vec3 gAux = vec3(0.0, 0.0, 0.5); float inWorld = 0.0;
      ${sampleCode}
      // apron outside the baked world: procedural fields and woods
      if (inWorld < 1.0) {
        vec2 cellId = floor(wp / 260.0 + vec2(vnoiseG(wp * 0.003), vnoiseG(wp * 0.003 + 5.0)) * 0.6);
        float hsh = hashI(cellId);
        vec3 fld = mix(sRGB(vec3(0.78, 0.67, 0.45)), sRGB(vec3(0.55, 0.45, 0.32)), step(0.6, hsh));
        fld = mix(fld, sRGB(vec3(0.55, 0.56, 0.33)), step(0.85, hsh));
        float woods = smoothstep(0.07, 0.16, slope) * 0.85 + smoothstep(0.55, 0.7, fbmG(wp * 0.0012, 4)) * 0.6;
        woods = clamp(woods + (vWPos.y > 700.0 ? -0.5 * smoothstep(700.0, 1000.0, vWPos.y) : 0.0), 0.0, 1.0);
        vec3 wood = sRGB(vec3(0.25, 0.29, 0.18)) * (0.7 + 0.6 * vnoiseG(wp * 0.05));
        vec3 bare = sRGB(vec3(0.62, 0.58, 0.42));
        vec3 ap = mix(fld, wood, woods);
        ap = mix(ap, bare, smoothstep(950.0, 1150.0, vWPos.y) * 0.7);
        gCol = mix(ap, gCol, inWorld);
        gMask = mix(vec3(0.0, 0.0, woods > 0.5 ? 1.0 : 0.2), gMask, inWorld);
      }
      gWater = smoothstep(0.35, 0.75, gMask.r);
      gRoad = gMask.g;
      float cls = gMask.b;
      gForest = smoothstep(0.80, 0.97, cls);
      float scrubW = smoothstep(0.82, 0.9, cls) * (1.0 - gForest);
      // large-scale tonal variation everywhere
      float n50 = fbmG(wp * 0.012, 4);
      gCol *= 0.86 + 0.28 * n50;
      // canopy mottling (crowns ~5 m) on woods
      float can = vnoiseG(wp * 0.22) * 0.6 + vnoiseG(wp * 0.55) * 0.4;
      float canF = octF(4.0, pxM);
      gCol *= mix(1.0, mix(1.0, 0.45 + 0.95 * can * can, canF) * 0.92, gForest);
      float open_ = (1.0 - gWater) * (1.0 - gForest) * (1.0 - gRoad);
      // per-field tone shift (dry straw <-> greener) from the field seed
      float ft = gAux.b - 0.5;
      gCol *= mix(vec3(1.0), vec3(1.0 + ft * 0.16, 1.0 + ft * 0.06, 1.0 - ft * 0.12), open_);
      // crop rows / furrows / vine rows: direction and spacing per field (aux texture)
      if (gAux.g > 0.02) {
        float kind = gAux.g;
        float ang = gAux.r * 3.14159265;
        vec2 dir = vec2(cos(ang), sin(ang));
        float sp = kind > 0.75 ? 0.9 : kind > 0.4 ? 2.4 : kind > 0.2 ? 1.6 : 6.5;
        float u = dot(wp, vec2(-dir.y, dir.x)) / sp + vnoiseG(wp * 0.05) * 0.8;
        float row = 0.5 + 0.5 * cos(u * 6.2831853);
        row = mix(row, vnoiseG(vec2(u * 3.0, dot(wp, dir) * 0.6)), 0.25);
        float str = (kind > 0.75 ? 0.32 : kind > 0.4 ? 0.26 : kind > 0.2 ? 0.14 : 0.1) * octF(sp, pxM);
        gCol *= mix(1.0, 0.8 + 0.4 * row, str * open_);
      }
      // multi-scale grain: 20 m, 4 m, 0.9 m, 0.25 m
      float g20 = fbmG(wp * 0.05, 3);
      float g4 = vnoiseG(wp * 0.25 + 3.7);
      float g1 = vnoiseG(wp * 1.1 + 1.3) * 0.6 + vnoiseG(wp * 2.3) * 0.4;
      float g0 = vnoiseG(wp * 4.1 + 9.1);
      gCol *= mix(1.0, 0.86 + 0.28 * g20, open_);
      gCol *= mix(1.0, 0.88 + 0.24 * g4, open_ * octF(4.0, pxM));
      gCol *= mix(1.0, 0.84 + 0.32 * g1, (1.0 - gWater) * (1.0 - gForest * 0.5) * octF(0.9, pxM));
      gCol *= mix(1.0, 0.88 + 0.24 * g0, (1.0 - gWater) * octF(0.25, pxM));
      // micro detail near the camera: grass clumps / gravel speckle (9 cm, 3 cm, blade streaks)
      float m9 = vnoiseG(wp * 11.0 + 2.0);
      float m3 = vnoiseG(wp * 31.0 + 7.0);
      float blades = vnoiseG(vec2(wp.x * 55.0 + wp.y * 12.0, wp.y * 9.0 - wp.x * 3.0));
      gCol *= mix(1.0, 0.72 + 0.56 * m9, (1.0 - gWater) * octF(0.09, pxM) * 0.85);
      gCol *= mix(1.0, 0.78 + 0.44 * m3, (1.0 - gWater) * octF(0.035, pxM) * 0.8);
      gCol *= mix(1.0, 0.8 + 0.4 * blades, open_ * octF(0.03, pxM) * 0.7);
      // dry, sun-bleached patches and bare soil
      float dry = smoothstep(0.58, 0.8, fbmG(wp * 0.09 + 11.0, 3));
      gCol = mix(gCol, gCol * vec3(1.18, 1.08, 0.86), dry * 0.55 * open_ * octF(6.0, pxM));
      float soil = smoothstep(0.66, 0.85, fbmG(wp * 0.21 + 5.0, 3));
      gCol = mix(gCol, sRGB(vec3(0.50, 0.40, 0.29)) * (0.8 + 0.4 * g1), soil * 0.35 * open_ * octF(2.0, pxM));
      // greener tufts in meadows/park (2-6 m)
      float patchN = vnoiseG(wp * 0.35);
      gCol = mix(gCol, gCol * vec3(0.84, 0.97, 0.74), smoothstep(0.62, 0.85, patchN) * 0.5 * open_ * octF(3.0, pxM));
      // road/path edge wear: dusty pale verge where the road mask fades out
      float verge = smoothstep(0.03, 0.35, gRoad) * (1.0 - smoothstep(0.45, 0.9, gRoad));
      gCol = mix(gCol, sRGB(vec3(0.66, 0.60, 0.48)) * (0.8 + 0.35 * g0), verge * 0.55 * (1.0 - gWater));
      // limestone and bare earth on steep faces
      gCol = mix(gCol, sRGB(vec3(0.62, 0.56, 0.47)) * (0.85 + 0.3 * g1), smoothstep(0.35, 0.6, slope) * 0.75);
      // road wear
      gCol *= mix(1.0, 0.9 + 0.2 * vnoiseG(wp * vec2(0.8, 0.8)), gRoad);
      // water body colour
      gCol = mix(gCol, sRGB(vec3(0.18, 0.21, 0.15)), gWater);
      diffuseColor.rgb = gCol;
      `],
      ['#include <roughnessmap_fragment>', `float roughnessFactor = mix(mix(0.96, 0.82, gRoad), 0.06, gWater);`],
      ['#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        // ripples on water, canopy relief on woods (view-space perturbation)
        float pxM2 = length(fwidth(gWp));
        vec2 rp = gWp * vec2(0.9, 2.3);
        float e = 0.5;
        float r0 = vnoiseG(rp), rx = vnoiseG(rp + vec2(e, 0.0)), ry = vnoiseG(rp + vec2(0.0, e));
        vec3 wDelta = vec3(r0 - rx, 0.0, -(r0 - ry)) * 0.35 * gWater * octF(1.0, pxM2);
        vec2 cp = gWp * 0.22;
        float c0 = vnoiseG(cp), cx = vnoiseG(cp + vec2(0.3, 0.0)), cy = vnoiseG(cp + vec2(0.0, 0.3));
        wDelta += vec3(c0 - cx, 0.0, -(c0 - cy)) * 2.2 * gForest * octF(4.0, pxM2);
        // lumpy grass / soil relief on open ground and a little on paths
        vec2 bp = gWp * 3.3;
        float b0 = vnoiseG(bp), bx = vnoiseG(bp + vec2(0.25, 0.0)), by = vnoiseG(bp + vec2(0.0, 0.25));
        wDelta += vec3(b0 - bx, 0.0, -(b0 - by)) * (1.6 - 1.1 * gRoad) * (1.0 - gWater) * (1.0 - gForest) * octF(0.3, pxM2);
        normal = normalize(normal + (viewMatrix * vec4(wDelta, 0.0)).xyz);
      }`],
    ],
  });
}

export function levelTextures(level, renderer) {
  const tex = new THREE.CanvasTexture(level.color);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const maskTex = new THREE.CanvasTexture(level.mask);
  maskTex.colorSpace = THREE.NoColorSpace;
  maskTex.anisotropy = tex.anisotropy;
  const auxTex = new THREE.CanvasTexture(level.aux);
  auxTex.colorSpace = THREE.NoColorSpace;
  auxTex.generateMipmaps = false;
  auxTex.minFilter = auxTex.magFilter = THREE.NearestFilter;
  return { tex, maskTex, auxTex, B: level.B };
}

export function heightTexture(hf) {
  const data = new Uint16Array(hf.h.length);
  for (let i = 0; i < hf.h.length; i++) data[i] = THREE.DataUtils.toHalfFloat(hf.h[i]);
  const t = new THREE.DataTexture(data, hf.cols, hf.rows, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
