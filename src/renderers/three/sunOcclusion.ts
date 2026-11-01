/**
 * Terrain shadows from the heightfield, for every world material: a GPU pass
 * marches from each ground texel toward the key light (sun or moon) and
 * stores the "clearance": how many metres above the ground a point there must
 * be to see the light (≤ 0 = lit ground). Materials compare their own height
 * above ground against it (atmosphere.ts `sunVisibility`), so tree tops and
 * roofs catch the last sun while the valley floor is already in the hill's
 * shadow — long golden-hour shadows at no per-pixel march cost.
 *
 * Recomputed only when the light moves (once a minute at most), spread over a
 * few frames in horizontal strips so no single frame pays for the whole map.
 */

import * as THREE from 'three';

import type { Heightfield } from '@/lib/world/heightfield';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uHeight;
uniform vec2 uSize;      // world metres covered (width, height)
uniform vec3 uSunDir;    // three.js direction toward the light
varying vec2 vUv;
float H(vec2 uv) { return texture2D(uHeight, uv).r; }
void main() {
  // uv: x east, y south (row 0 = north edge), matching the height texture.
  vec2 sd = normalize(vec2(uSunDir.x, uSunDir.z)); // three z = south
  float horiz = max(length(uSunDir.xz), 1e-4);
  float tanE = uSunDir.y / horiz;
  vec2 stepUv = sd / uSize;
  float h0 = H(vUv) + 1.0;
  float c = -60.0;
  float t = 14.0;
  for (int i = 0; i < 64; i++) {
    vec2 q = vUv + stepUv * t;
    if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) break;
    c = max(c, H(q) - (h0 + t * tanE));
    t *= 1.105;
  }
  gl_FragColor = vec4(clamp(c, -60.0, 3000.0), 0.0, 0.0, 1.0);
}`;

export interface SunOcclusionOptions {
  /** Map texels per heightfield node along each axis (0.5 = half resolution). */
  scale?: number;
  /** Strips per full update. */
  strips?: number;
}

export class SunOcclusion {
  readonly heightTexture: THREE.DataTexture;
  readonly target: THREE.WebGLRenderTarget;
  /** Lowest height in the world; the height texture stores h − base. */
  readonly heightBase: number;
  readonly box: THREE.Vector4;
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly strips: number;
  private pending = 0;
  private nextStrip = 0;
  /** True once a full map has been computed at least once. */
  ready = false;

  constructor(hf: Heightfield, opts: SunOcclusionOptions = {}) {
    const { cols, rows, cellSize, xMin, yMax } = hf.spec;
    this.heightBase = hf.spec.heightOffset;
    const data = new Uint16Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) data[r * cols + c] = THREE.DataUtils.toHalfFloat(hf.nodeHeight(c, r) - this.heightBase);
    }
    this.heightTexture = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.minFilter = THREE.LinearFilter;
    this.heightTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTexture.flipY = false;
    this.heightTexture.needsUpdate = true;

    const scale = opts.scale ?? 0.5;
    const w = Math.max(16, Math.round(cols * scale));
    const h = Math.max(16, Math.round(rows * scale));
    this.target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.target.texture.name = 'sun-occlusion';
    const widthM = (cols - 1) * cellSize;
    const heightM = (rows - 1) * cellSize;
    // Shaders map three (x, z) → uv with x = (x − xMin)/W and v = (z + yMax)/H (z = −y, row 0 = north).
    this.box = new THREE.Vector4(xMin, yMax, 1 / widthM, 1 / heightM);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHeight: { value: this.heightTexture },
        uSize: { value: new THREE.Vector2(widthM, heightM) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.strips = Math.max(1, opts.strips ?? 4);
  }

  /** Schedule a recompute for a new light direction (three.js, toward the light). */
  setLight(dir: THREE.Vector3) {
    (this.material.uniforms.uSunDir.value as THREE.Vector3).copy(dir).normalize();
    this.pending = this.strips;
    this.nextStrip = 0;
  }

  /** Render one pending strip (call once per frame). Returns true while work remains. */
  step(renderer: THREE.WebGLRenderer): boolean {
    if (this.pending <= 0) return false;
    const { width, height } = this.target;
    const y0 = Math.floor((this.nextStrip * height) / this.strips);
    const y1 = Math.floor(((this.nextStrip + 1) * height) / this.strips);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    this.target.scissor.set(0, y0, width, y1 - y0);
    this.target.scissorTest = true;
    this.target.viewport.set(0, 0, width, height);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    this.target.scissorTest = false;
    this.nextStrip++;
    this.pending--;
    if (this.pending === 0) this.ready = true;
    return this.pending > 0;
  }

  dispose() {
    this.heightTexture.dispose();
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
