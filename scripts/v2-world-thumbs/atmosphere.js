// Sky, clouds, moods and the aerial-perspective patch shared by every material.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const D2R = Math.PI / 180;

/**
 * Mood presets. Sun azimuth is degrees clockwise from north. Fog: haze is a
 * uniform extinction per metre (aerial perspective); fogDensity/falloff/base
 * add an exponential height-fog layer (valley fog).
 */
export const MOODS = {
  // low western sun, backlit haze glowing toward the sun, cool sky fill
  'golden-hour': {
    sunAz: 263, sunEl: 4.2, turbidity: 7.5, rayleigh: 2.6, mie: 0.008, mieG: 0.88,
    exposure: 0.6, sun: 4.6, sunColor: '#ffa45a', hemiSky: '#7b8fb4', hemiGround: '#5a4630', hemi: 0.3, env: 0.42,
    haze: 1 / 11000, fogDensity: 1 / 5200, fogFalloff: 1 / 150, fogBase: 175, fogTint: '#ffc98e', fogTintMix: 0.18,
    sunHaze: 0.55, hazeTint: '#ffe2c0', hazeG: 0.78,
    clouds: 0.22, cloudH: 2600, night: 0,
  },
  'late-afternoon': {
    sunAz: 268, sunEl: 12, turbidity: 5.5, rayleigh: 2.0, mie: 0.006, mieG: 0.85,
    exposure: 0.5, sun: 4.4, sunColor: '#ffc788', hemiSky: '#8ea3c8', hemiGround: '#6a5638', hemi: 0.34, env: 0.48,
    haze: 1 / 13000, fogDensity: 1 / 7000, fogFalloff: 1 / 200, fogBase: 175, fogTint: '#f6dcb4', fogTintMix: 0.14,
    sunHaze: 0.32, hazeTint: '#f8e6cf', hazeG: 0.72,
    clouds: 0.28, cloudH: 2400, night: 0,
  },
  'clear-afternoon': {
    sunAz: 228, sunEl: 34, turbidity: 3.2, rayleigh: 1.4, mie: 0.004, mieG: 0.8,
    exposure: 0.42, sun: 3.4, sunColor: '#fff1dc', hemiSky: '#b8cbe6', hemiGround: '#7a6a4c', hemi: 0.4, env: 0.6,
    haze: 1 / 21000, fogDensity: 1 / 9000, fogFalloff: 1 / 250, fogBase: 170, fogTint: '#d8e2ee', fogTintMix: 0.15,
    sunHaze: 0.12, hazeTint: '#f2efe8', hazeG: 0.7,
    clouds: 0.3, cloudH: 2200, night: 0,
  },
  'clear-noon': {
    sunAz: 185, sunEl: 55, turbidity: 3.0, rayleigh: 1.3, mie: 0.004, mieG: 0.8,
    exposure: 0.4, sun: 3.4, sunColor: '#fff6ea', hemiSky: '#b8cbe6', hemiGround: '#7a6a4c', hemi: 0.4, env: 0.6,
    haze: 1 / 20000, fogDensity: 1 / 9000, fogFalloff: 1 / 250, fogBase: 170, fogTint: '#d8e2ee', fogTintMix: 0.15,
    sunHaze: 0.1, hazeTint: '#f2efe8', hazeG: 0.7,
    clouds: 0.25, cloudH: 2200, night: 0,
  },
  overcast: {
    sunAz: 210, sunEl: 40, turbidity: 10, rayleigh: 0.8, mie: 0.02, mieG: 0.7,
    exposure: 0.62, sun: 0.55, sunColor: '#e8e8e4', hemiSky: '#c9ced3', hemiGround: '#6d6858', hemi: 1.15, env: 1.0,
    haze: 1 / 9000, fogDensity: 1 / 5000, fogFalloff: 1 / 300, fogBase: 170, fogTint: '#b9bec2', fogTintMix: 0.65,
    sunHaze: 0.0, hazeTint: '#ffffff', hazeG: 0.7,
    clouds: 1.0, cloudH: 1500, overcast: 1, night: 0,
  },
  // early sun from the east over a lit fog sea in the valley
  'valley-fog': {
    sunAz: 98, sunEl: 6.5, turbidity: 6, rayleigh: 2.2, mie: 0.007, mieG: 0.87,
    exposure: 0.55, sun: 4.2, sunColor: '#ffb878', hemiSky: '#8a9cc0', hemiGround: '#5d5648', hemi: 0.34, env: 0.5,
    haze: 1 / 22000, fogDensity: 1 / 40, fogFalloff: 1 / 11, fogBase: 252, fogTint: '#ffe6c8', fogTintMix: 0.7,
    sunHaze: 0.45, hazeTint: '#ffe8cc', hazeG: 0.78,
    clouds: 0.1, cloudH: 3000, night: 0,
  },
  'blue-hour': {
    sunAz: 278, sunEl: -3.2, turbidity: 4, rayleigh: 2.5, mie: 0.005, mieG: 0.8,
    exposure: 0.7, sun: 0.0, sunColor: '#ff9a60', hemiSky: '#3e5486', hemiGround: '#1e1c1c', hemi: 0.26, env: 0.85,
    haze: 1 / 12000, fogDensity: 1 / 6000, fogFalloff: 1 / 150, fogBase: 175, fogTint: '#2c3a5c', fogTintMix: 0.2,
    sunHaze: 0.0, hazeTint: '#c9d4ff', hazeG: 0.7,
    clouds: 0.18, cloudH: 2600, night: 1,
  },
};

export function sunDirection(mood) {
  const az = mood.sunAz * D2R, el = mood.sunEl * D2R;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

/** Sky.js scattering + a procedural cloud layer + twilight boost, as one material. */
export function makeSkyMaterial(mood, sunDir) {
  const base = Sky.SkyShader;
  const frag = base.fragmentShader
    .replace('uniform vec3 up;', `uniform vec3 up;
      uniform float uClouds; uniform float uCloudH; uniform float uOvercast; uniform float uNight; uniform vec3 uSunReal; uniform float uSkyGain;
      float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
      float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
      float fbmS(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<6;i++){ s+=a*vn(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return s; }`)
    .replace('gl_FragColor = vec4( retColor, 1.0 );', `
      vec3 col = retColor * uSkyGain;
      // twilight: lift the blue overhead and keep a warm band on the sunset side
      if (uNight > 0.0) {
        float el = max(direction.y, 0.0);
        vec2 hs = normalize(uSunReal.xz + 1e-5); vec2 hd = normalize(direction.xz + 1e-5);
        float toward = 0.5 + 0.5 * dot(hs, hd);
        vec3 zen = vec3(0.020, 0.040, 0.105);
        vec3 hor = mix(vec3(0.08, 0.11, 0.22), vec3(0.50, 0.26, 0.14), pow(toward, 5.0));
        vec3 tw = mix(hor, zen, pow(el, 0.4));
        tw += vec3(0.30, 0.13, 0.05) * pow(toward, 12.0) * exp(-el * 26.0);
        col = tw * 1.2 + col * 0.4;
      }
      // cloud layer on a plane uCloudH above the camera
      if (uClouds > 0.0 && direction.y > 0.0) {
        float t = (uCloudH) / max(direction.y, 0.02);
        vec2 p = (cameraPosition.xz + direction.xz * t) * 0.00022 + vec2(3.1, 7.7);
        float cov = mix(0.62, 0.0, uClouds);
        float n = fbmS(p);
        float d = smoothstep(cov, cov + 0.28, n);
        float n2 = fbmS(p + normalize(uSunReal.xz + 1e-5) * 0.06);
        float lit = clamp(0.55 + (n - n2) * 4.0, 0.0, 1.0);
        float mu = dot(direction, normalize(uSunReal));
        vec3 sunC = mix(vec3(1.0, 0.62, 0.38), vec3(1.0, 0.97, 0.92), clamp(uSunReal.y * 4.0, 0.0, 1.0));
        vec3 cBright = sunC * (0.85 + 1.6 * pow(max(mu, 0.0), 6.0));
        vec3 cDark = mix(col, vec3(0.36, 0.38, 0.43), 0.6);
        vec3 cc = mix(cDark, cBright, lit);
        if (uOvercast > 0.5) {
          float o = fbmS(p * 0.6 + 3.0);
          cc = mix(vec3(0.50, 0.52, 0.55), vec3(0.78, 0.79, 0.80), smoothstep(0.25, 0.75, o));
          d = 1.0;
        }
        if (uNight > 0.0) cc = mix(vec3(0.05, 0.06, 0.10), vec3(0.85, 0.42, 0.22), pow(max(mu, 0.0), 3.0) * 0.8);
        float fade = smoothstep(0.0, 0.16, direction.y) * exp(-t / 90000.0);
        col = mix(col, cc, d * fade * (uOvercast > 0.5 ? 1.0 : 0.9));
        if (uOvercast > 0.5) col = mix(col, vec3(0.70, 0.72, 0.74), 1.0 - fade);
      }
      gl_FragColor = vec4( col, 1.0 );`);
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsUtils.clone(base.uniforms),
      { uClouds: { value: mood.clouds }, uCloudH: { value: mood.cloudH }, uOvercast: { value: mood.overcast ?? 0 },
        uNight: { value: mood.night }, uSunReal: { value: sunDir.clone() }, uSkyGain: { value: mood.skyGain ?? 1 } },
    ]),
    vertexShader: base.vertexShader,
    fragmentShader: frag,
    side: THREE.BackSide,
    depthWrite: false,
  });
  mat.uniforms.turbidity.value = mood.turbidity;
  mat.uniforms.rayleigh.value = mood.rayleigh;
  mat.uniforms.mieCoefficient.value = mood.mie;
  mat.uniforms.mieDirectionalG.value = mood.mieG;
  // Sky.js goes black below ~-2.3 deg; keep the scattering at the horizon for twilight
  const s = sunDir.clone();
  if (s.y < 0) s.y = Math.max(s.y, -0.025);
  mat.uniforms.sunPosition.value.copy(s.normalize());
  return mat;
}

/** Shared uniforms for the aerial perspective / height fog / terrain shadow. */
export function atmoUniforms() {
  return {
    uSkyCube: { value: null },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uHaze: { value: 1 / 20000 },
    uFogDensity: { value: 0 },
    uFogFalloff: { value: 1 / 200 },
    uFogBase: { value: 170 },
    uFogTint: { value: new THREE.Color(1, 1, 1) },
    uFogTintMix: { value: 0 },
    uViewInv: { value: new THREE.Matrix4() },
    uHeightTex: { value: null },
    uHfBox: { value: new THREE.Vector4() }, // xMin, yMax, cell, unused
    uHfSize: { value: new THREE.Vector2() },
    uSunShadow: { value: 1 },
    uNight: { value: 0 },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uSunHaze: { value: 0 },
    uHazeTint: { value: new THREE.Color(1, 1, 1) },
    uHazeG: { value: 0.75 },
  };
}

export const ATMO_GLSL = /* glsl */ `
uniform samplerCube uSkyCube;
uniform vec3 uSunDir;
uniform float uHaze, uFogDensity, uFogFalloff, uFogBase, uFogTintMix, uSunShadow, uNight, uSunHaze, uHazeG;
uniform vec3 uFogTint, uSunCol, uHazeTint;
vec3 gSunLit = vec3(0.0); // shadowed sun radiance reaching this fragment (set in the light loop)
uniform sampler2D uHeightTex;
uniform vec4 uHfBox;
uniform vec2 uHfSize;
varying vec3 vWPos;

float hfSample(vec2 p) {
  vec2 uv = vec2((p.x - uHfBox.x) / uHfBox.z + 0.5, (uHfBox.y - p.y) / uHfBox.z + 0.5) / uHfSize;
  return texture2D(uHeightTex, uv).r;
}
bool hfInside(vec2 p) {
  vec2 c = vec2((p.x - uHfBox.x) / uHfBox.z, (uHfBox.y - p.y) / uHfBox.z);
  return c.x >= 0.0 && c.y >= 0.0 && c.x <= uHfSize.x - 1.0 && c.y <= uHfSize.y - 1.0;
}
// soft terrain shadow: march the heightfield toward the sun
float terrainShadow(vec3 wp) {
  if (uSunDir.y <= 0.0) return 0.0;
  vec2 p = vec2(wp.x, -wp.z);
  if (!hfInside(p)) return 1.0;
  vec2 sd = normalize(vec2(uSunDir.x, -uSunDir.z));
  float tanE = uSunDir.y / max(length(uSunDir.xz), 1e-4);
  float h = wp.y + 1.6;
  float t = 20.0;
  float sh = 1.0;
  for (int i = 0; i < 72; i++) {
    vec2 q = p + sd * t;
    if (!hfInside(q)) break;
    float th = hfSample(q);
    float dh = (h + t * tanE - th) / t;
    sh = min(sh, smoothstep(-0.012, 0.025, dh));
    if (sh < 0.01) break;
    t *= 1.11;
  }
  return sh;
}
vec3 applyAtmo(vec3 col, vec3 wp) {
  vec3 ro = cameraPosition;
  vec3 d = wp - ro;
  float dist = length(d);
  vec3 rd = d / max(dist, 1e-3);
  // exponential height fog integral (Quilez)
  float b = uFogFalloff;
  float h0 = ro.y - uFogBase;
  float k = b * rd.y * dist;
  float fogAmt = uFogDensity * exp(-b * h0) * (abs(k) > 1e-4 ? (1.0 - exp(-k)) / (b * rd.y) : dist);
  fogAmt = min(fogAmt, 60.0);
  float trans = exp(-fogAmt - uHaze * dist);
  vec3 sdir = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.35 + 0.025, rd.z));
  vec3 fogCol = textureCube(uSkyCube, sdir).rgb;
  // height-fog layer is lit, sunward glow
  float mu = max(dot(rd, uSunDir), 0.0);
  vec3 tint = uFogTint * (0.75 + 0.6 * pow(mu, 6.0));
  float layer = 1.0 - exp(-fogAmt);
  fogCol = mix(fogCol, tint * max(dot(fogCol, vec3(0.333)) * 1.6, 0.05), uFogTintMix * clamp(layer * 1.4, 0.0, 1.0) + uFogTintMix * 0.25);
  // luminous aerial perspective: warm the airlight and add Mie forward scatter toward the sun
  float g = uHazeG, cmu = dot(rd, uSunDir);
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cmu, 1.5) * 0.0796;
  fogCol = fogCol * uHazeTint + uSunCol * uSunHaze * (hg + 0.06) * (0.6 + 0.4 * layer);
  return col * trans + fogCol * (1.0 - trans);
}
`;

/**
 * Patch a built-in material: aerial perspective before tone mapping, terrain
 * shadow on the sun, world-position varying. `extra` lets callers inject more.
 */
export function patchMaterial(mat, U, extra = {}) {
  mat.fog = false;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    Object.assign(shader.uniforms, U);
    if (extra.uniforms) Object.assign(shader.uniforms, extra.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform mat4 uViewInv; varying vec3 vWPos; ${extra.vertexPars ?? ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vWPos = (uViewInv * mvPosition).xyz; ${extra.vertexMain ?? ''}`);
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${ATMO_GLSL}
        ${extra.fragmentPars ?? ''}`)
      .replace('#include <fog_fragment>', '')
      .replace('#include <tonemapping_fragment>', `
        ${extra.beforeAtmo ?? ''}
        gl_FragColor.rgb = applyAtmo(gl_FragColor.rgb, vWPos);
        #include <tonemapping_fragment>`)
      .replace('#include <lights_fragment_begin>', `float tShadow = mix(1.0, terrainShadow(vWPos), uSunShadow);
        ${extra.preLights ?? ''}
        ${THREE.ShaderChunk.lights_fragment_begin.replace(
          'getDirectionalLightInfo( directionalLight, directLight );',
          'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= tShadow;').replace(
          'vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\t#endif\n',
          'vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\t#endif\n\t\tgSunLit = directLight.color;\n')}
        ${extra.postLightsSetup ?? ''}`);
    if (extra.fragmentReplace) for (const [a, b] of extra.fragmentReplace) fs = fs.replace(a, b);
    shader.fragmentShader = fs;
    if (prev) prev(shader, r);
  };
  mat.customProgramCacheKey = () => (extra.key ?? '') + mat.type;
  return mat;
}
