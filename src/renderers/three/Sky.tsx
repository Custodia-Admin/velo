/**
 * Sky and light for the world renderer: a scattering sky dome (three's Sky
 * model) with drifting clouds, a closed deck when overcast and a starry
 * blue-hour/night sky; the key light (sun, or moon at night) with its shadow
 * box riding along with the rider; a hemisphere fill; image-based light from
 * the same sky; and the shared atmosphere uniforms every world material
 * reads. The light itself comes from lib/world/moods (`worldLight`): time of
 * day from the clock (or the route's golden hour / a pinned preset) and the
 * live weather.
 */

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Sky as SkyObject } from 'three/addons/objects/Sky.js';

import { worldLight, worldLightKey, type WorldLight, type WorldLightInput } from '@/lib/world/moods';

import type { WorldAtmosphere } from './materials/atmosphere';
import type { ThreeQuality } from './quality';
import { sunDirection } from './skyModel';
import type { SunOcclusion } from './sunOcclusion';
import type { RideFrame } from './worldScene';

/** Mutable light state shared with the other world components. */
export interface LightState {
  current: WorldLight | null;
  /** Bumped whenever `current` changes. */
  version: number;
}

export function createLightState(): LightState {
  return { current: null, version: 0 };
}

const SKY_EXTRA_UNIFORMS = /* glsl */ `
uniform float uNight;
uniform float uOvercast;
uniform float uSkyGain;
uniform vec3 uSunReal;
uniform vec3 uDeck;
float sHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
`;

const SKY_TAIL = /* glsl */ `
  vec3 col = texColor * uSkyGain;
  if (uNight > 0.0) {
    // Blue hour → night: a lit band on the sunset side, deep blue overhead, stars.
    float el = max(direction.y, 0.0);
    vec2 hs = normalize(uSunReal.xz + 1e-5);
    vec2 hd = normalize(direction.xz + 1e-5);
    float toward = 0.5 + 0.5 * dot(hs, hd);
    float dusk = clamp((uSunReal.y + 0.2) / 0.16, 0.0, 1.0);
    vec3 zen = mix(vec3(0.006, 0.011, 0.03), vec3(0.020, 0.040, 0.105), dusk);
    vec3 hor = mix(vec3(0.02, 0.03, 0.06), mix(vec3(0.08, 0.11, 0.22), vec3(0.50, 0.26, 0.14), pow(toward, 5.0)), dusk);
    vec3 tw = mix(hor, zen, pow(el, 0.4));
    tw += vec3(0.30, 0.13, 0.05) * pow(toward, 12.0) * exp(-el * 26.0) * dusk;
    vec3 sp = floor(direction * 420.0);
    float star = step(0.9965, sHash(sp)) * smoothstep(0.05, 0.3, direction.y) * (1.0 - uOvercast);
    tw += vec3(0.9, 0.92, 1.0) * star * 0.35 * (1.0 - dusk);
    col = mix(col, tw * 1.2 + col * 0.4, uNight);
  }
  if (uOvercast > 0.0) {
    // A closed grey deck with soft mottling; brighter overhead, hazier at the horizon.
    vec2 p = direction.xz / max(direction.y, 0.04) * 0.9 + vec2(time * 0.0006, 0.0);
    float o = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) { o += a * (noise(p) * 0.5 + 0.5); p = p * 2.03 + 1.7; a *= 0.5; }
    vec3 deck = uDeck * mix(0.82, 1.08, smoothstep(0.3, 0.75, o));
    deck *= mix(0.9, 1.05, smoothstep(0.0, 0.6, direction.y));
    float horizon = smoothstep(-0.02, 0.18, direction.y);
    col = mix(col, mix(uDeck * 1.02, deck, horizon), uOvercast);
  }
  gl_FragColor = vec4( col, 1.0 );`;

function createSkyMaterial(): THREE.ShaderMaterial {
  const base = SkyObject.SkyShader as unknown as { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };
  const frag = base.fragmentShader
    .replace('uniform float time;', `uniform float time;\n${SKY_EXTRA_UNIFORMS}`)
    .replace('gl_FragColor = vec4( texColor, 1.0 );', SKY_TAIL);
  return new THREE.ShaderMaterial({
    name: 'velo-sky',
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsUtils.clone(base.uniforms),
      {
        uNight: { value: 0 },
        uOvercast: { value: 0 },
        uSkyGain: { value: 1 },
        uSunReal: { value: new THREE.Vector3(0, 1, 0) },
        uDeck: { value: new THREE.Color(0.06, 0.062, 0.066) },
      },
    ]),
    vertexShader: base.vertexShader,
    fragmentShader: frag,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

const srgb = (c: readonly [number, number, number], out = new THREE.Color()) => out.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

/** Push a light into the sky material, lights and atmosphere uniforms. Exported for tests. */
/** Overcast deck radiance by day (sky-model units: a light-grey deck at the overcast exposure). */
export const DECK_DAY = 0.55;
/**
 * Moods give the hemisphere fill on the offline stills' scale; three.js
 * divides it by π like the sun. The sky's own light comes from the captured
 * environment (moods' `env`); this keeps the warm ground bounce visible.
 */
export const HEMI_GAIN = 2.5;

export function applyLight(
  light: WorldLight,
  parts: {
    sky: THREE.ShaderMaterial;
    key: THREE.DirectionalLight;
    hemi: THREE.HemisphereLight;
    atmo: WorldAtmosphere;
    keyDir: THREE.Vector3;
  },
): void {
  const { sky, key, hemi, atmo, keyDir } = parts;
  const sun = sunDirection(light.sun.azimuthDeg, light.sun.altitudeDeg);
  const u = sky.uniforms;
  // three's Sky goes black below about −2°: hold its sun at the horizon and let the night overlay take over.
  const skySun = new THREE.Vector3(sun[0], Math.max(sun[1], -0.025), sun[2]).normalize();
  u.sunPosition.value.copy(skySun);
  u.uSunReal.value.set(sun[0], sun[1], sun[2]);
  u.turbidity.value = light.sky.turbidity;
  u.rayleigh.value = light.sky.rayleigh;
  u.mieCoefficient.value = light.sky.mie;
  u.mieDirectionalG.value = light.sky.mieG;
  u.cloudCoverage.value = light.sky.overcast > 0.5 ? 0 : light.sky.clouds * 0.75;
  u.cloudDensity.value = 0.45 + 0.4 * light.sky.clouds;
  u.cloudElevation.value = 0.55;
  u.cloudScale.value = 0.00022;
  u.cloudSpeed.value = 0.00003;
  u.showSunDisc.value = light.sky.overcast > 0.5 ? 0 : 1;
  u.uNight.value = light.night;
  u.uOvercast.value = light.sky.overcast;
  // The deck's brightness follows the daylight (dark slate at night).
  const deckDay = DECK_DAY * (1 - light.night) + 0.012;
  const rainy = light.weather.rain > 0;
  u.uDeck.value.setRGB(deckDay * (rainy ? 0.84 : 0.96), deckDay * (rainy ? 0.88 : 0.98), deckDay * (rainy ? 0.93 : 1.0));

  const k = sunDirection(light.key.azimuthDeg, light.key.altitudeDeg);
  keyDir.set(k[0], k[1], k[2]).normalize();
  srgb(light.key.color, key.color);
  key.intensity = light.key.intensity;
  srgb(light.hemi.sky, hemi.color);
  srgb(light.hemi.ground, hemi.groundColor);
  hemi.intensity = light.hemi.intensity * HEMI_GAIN;

  const a = atmo.uniforms;
  a.uSunDir.value.copy(keyDir);
  srgb(light.key.color, a.uSunCol.value).multiplyScalar(light.key.intensity / 4);
  a.uHaze.value = light.atmosphere.haze;
  a.uFogDensity.value = light.atmosphere.fogDensity;
  a.uFogFalloff.value = light.atmosphere.fogFalloff;
  a.uFogBase.value = light.atmosphere.fogBaseM;
  srgb(light.atmosphere.fogTint, a.uFogTint.value);
  a.uFogTintMix.value = light.atmosphere.fogTintMix;
  a.uSunHaze.value = light.atmosphere.sunHaze;
  srgb(light.atmosphere.hazeTint, a.uHazeTint.value);
  a.uHazeG.value = light.atmosphere.hazeG;
  a.uNight.value = light.night;
  a.uWet.value = light.weather.wet;
  a.uCloud.value.x = light.weather.cloudShadow * 0.55;
  a.uCloud.value.y = light.sky.clouds;
  a.uCloudH.value = light.sky.cloudHeightM;
  // Wind blows FROM windFromDeg: sway toward the opposite bearing (three x east, z south).
  const to = ((light.weather.windFromDeg + 180) * Math.PI) / 180;
  a.uWind.value.set(Math.min(1.5, 0.15 + light.weather.windMs / 8), Math.sin(to), -Math.cos(to));
}

export function Sky({
  frame,
  lightInput,
  quality,
  atmo,
  occlusion,
  lightState,
}: {
  frame: RideFrame;
  /** Everything but the clock; the component samples the clock itself. */
  lightInput: Omit<WorldLightInput, 'date'>;
  quality: ThreeQuality;
  atmo: WorldAtmosphere;
  occlusion: SunOcclusion | null;
  lightState: LightState;
}) {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);

  const parts = useMemo(() => {
    const sky = createSkyMaterial();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), sky);
    dome.name = 'sky';
    dome.frustumCulled = false;
    dome.renderOrder = -1;
    const key = new THREE.DirectionalLight('#ffffff', 3);
    key.name = 'sun';
    const hemi = new THREE.HemisphereLight('#ffffff', '#444444', 0.4);
    hemi.name = 'sky-light';
    // Sky capture for fog colour and image-based light.
    const skyScene = new THREE.Scene();
    const capDome = new THREE.Mesh(dome.geometry, sky);
    capDome.scale.setScalar(1000);
    capDome.frustumCulled = false;
    skyScene.add(capDome);
    const cubeRT = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cubeCam = new THREE.CubeCamera(1, 5000, cubeRT);
    skyScene.add(cubeCam);
    return { sky, dome, key, hemi, skyScene, cubeRT, cubeCam, keyDir: new THREE.Vector3(0, 1, 0) };
  }, []);

  const pmrem = useMemo(() => new THREE.PMREMGenerator(gl), [gl]);
  const env = useMemo(() => ({ rt: null as THREE.WebGLRenderTarget | null, key: '', checkAt: 0, captureFrames: 0 }), []);

  useEffect(() => {
    atmo.uniforms.uSkyCube.value = parts.cubeRT.texture;
    if (occlusion) {
      atmo.uniforms.uOcc.value = occlusion.target.texture;
      atmo.uniforms.uHeight.value = occlusion.heightTexture;
      atmo.uniforms.uHeightBase.value = occlusion.heightBase;
      atmo.uniforms.uOccBox.value.copy(occlusion.box);
    }
    atmo.uniforms.uOccOn.value = 0;
    // A new input (mood, weather, preset) applies on the next frame.
    env.key = '';
    env.checkAt = 0;
  }, [atmo, parts, occlusion, env, lightInput]);

  useEffect(() => {
    const { key } = parts;
    key.castShadow = quality.shadows;
    key.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const cam = key.shadow.camera as THREE.OrthographicCamera;
    const b = quality.shadowBoxM;
    cam.left = -b;
    cam.right = b;
    cam.top = b;
    cam.bottom = -b;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.map?.dispose();
    key.shadow.map = null;
  }, [parts, quality.shadows, quality.shadowMapSize, quality.shadowBoxM]);

  useEffect(
    () => () => {
      parts.dome.geometry.dispose();
      parts.sky.dispose();
      parts.cubeRT.dispose();
      parts.key.shadow.map?.dispose();
      parts.key.dispose();
      parts.hemi.dispose();
      env.rt?.dispose();
      pmrem.dispose();
      scene.environment = null;
      scene.background = null;
    },
    [parts, pmrem, env, scene],
  );

  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime;
    const now = Date.now();
    if (now >= env.checkAt) {
      env.checkAt = now + 5000;
      const input: WorldLightInput = { ...lightInput, date: new Date(now) };
      const k = worldLightKey(input);
      if (k !== env.key) {
        env.key = k;
        const light = worldLight(input);
        applyLight(light, { sky: parts.sky, key: parts.key, hemi: parts.hemi, atmo, keyDir: parts.keyDir });
        parts.key.castShadow = quality.shadows && light.key.castsShadow;
        gl.toneMappingExposure = light.exposure;
        scene.environmentIntensity = light.env;
        lightState.current = light;
        lightState.version++;
        occlusion?.setLight(parts.keyDir);
        env.captureFrames = 1;
      }
    }
    // Sky capture → fog colour + PMREM environment (the frame after a light change).
    if (env.captureFrames > 0) {
      env.captureFrames--;
      parts.sky.uniforms.time.value = t;
      parts.cubeCam.update(gl, parts.skyScene);
      const next = pmrem.fromCubemap(parts.cubeRT.texture);
      env.rt?.dispose();
      env.rt = next;
      scene.environment = next.texture;
    }
    if (occlusion && !occlusion.step(gl) && occlusion.ready) atmo.uniforms.uOccOn.value = 1;

    parts.sky.uniforms.time.value = t;
    atmo.uniforms.uTime.value = t;
    // Clouds and their shadows drift with the wind.
    const w = atmo.uniforms.uWind.value;
    atmo.uniforms.uCloud.value.z = -w.y * t * 6;
    atmo.uniforms.uCloud.value.w = -w.z * t * 6;

    const cam = camera as THREE.PerspectiveCamera;
    parts.dome.position.copy(camera.position);
    parts.dome.scale.setScalar(cam.far * 0.95);
    const p = frame.placement?.position;
    if (p) {
      const d = parts.keyDir;
      parts.key.target.position.set(p.x, p.y, p.z);
      parts.key.position.set(p.x + d.x * 200, p.y + d.y * 200, p.z + d.z * 200);
      parts.key.target.updateMatrixWorld();
    }
  });

  return (
    <>
      <primitive object={parts.dome} />
      <primitive object={parts.key} />
      <primitive object={parts.key.target} />
      <primitive object={parts.hemi} />
    </>
  );
}
