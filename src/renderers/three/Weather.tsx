/**
 * Falling rain (and snow) around the camera when the light says it is
 * raining: one draw call of short streaks in a box that wraps around the
 * camera, slanted by the live wind, lit by the sky, fading with distance.
 * Nothing is drawn on a dry day.
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import type { WorldAtmosphere } from './materials/atmosphere';
import type { ThreeQuality } from './quality';
import type { LightState } from './Sky';

/** Side of the precipitation box around the camera, metres. */
export const RAIN_BOX_M = 36;

const VERT = /* glsl */ `
attribute vec4 aDrop;
attribute float aEnd;
uniform float uTime;
uniform float uBox;
uniform float uFall;
uniform float uStreak;
uniform vec3 uWind;
uniform vec3 uCam;
varying float vFade;
void main() {
  float speed = uFall * (0.8 + 0.4 * aDrop.w);
  vec3 vel = vec3(uWind.y * uWind.x * 4.0, -speed, uWind.z * uWind.x * 4.0);
  // Wrap a seed position, moved by the fall, into a box centred on the camera.
  vec3 p = aDrop.xyz * uBox + vel * uTime;
  p = mod(p - uCam + 0.5 * uBox, uBox) - 0.5 * uBox + uCam;
  p -= vel * uStreak * aEnd;
  vFade = (1.0 - smoothstep(0.25 * uBox, 0.5 * uBox, length(p - uCam))) * (0.6 + 0.4 * aDrop.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  gl_FragColor = vec4(uColor, uOpacity * vFade);
}`;

export function createRainGeometry(count: number, seed = 1): THREE.BufferGeometry {
  const drop = new Float32Array(count * 2 * 4);
  const end = new Float32Array(count * 2);
  let s = seed >>> 0;
  const r = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const x = r();
    const y = r();
    const z = r();
    const w = r();
    for (let k = 0; k < 2; k++) {
      drop.set([x, y, z, w], (i * 2 + k) * 4);
      end[i * 2 + k] = k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('aDrop', new THREE.BufferAttribute(drop, 4));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  // Positions are computed in the shader; three still wants a position attribute for draw ranges.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}

export function Weather({ quality, atmo, lightState }: { quality: ThreeQuality; atmo: WorldAtmosphere; lightState: LightState }) {
  const lines = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: atmo.uniforms.uTime,
        uWind: atmo.uniforms.uWind,
        uBox: { value: RAIN_BOX_M },
        uFall: { value: 9 },
        uStreak: { value: 0.045 },
        uCam: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Color(0.6, 0.62, 0.66) },
        uOpacity: { value: 0.35 },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const l = new THREE.LineSegments(createRainGeometry(Math.max(1, quality.rainDrops)), mat);
    l.name = 'rain';
    l.frustumCulled = false;
    l.visible = false;
    l.renderOrder = 3;
    return l;
  }, [atmo, quality.rainDrops]);
  useEffect(
    () => () => {
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
    },
    [lines],
  );
  const seen = useMemo(() => ({ version: -1 }), []);
  useFrame(({ camera }) => {
    const u = (lines.material as THREE.ShaderMaterial).uniforms;
    if (lightState.version !== seen.version) {
      seen.version = lightState.version;
      const w = lightState.current?.weather;
      const amount = Math.max(w?.rain ?? 0, w?.snow ?? 0);
      lines.visible = amount > 0 && quality.rainDrops > 0;
      const snow = (w?.snow ?? 0) > (w?.rain ?? 0);
      u.uFall.value = snow ? 1.2 : 9;
      u.uStreak.value = snow ? 0.03 : 0.045;
      u.uOpacity.value = (snow ? 0.75 : 0.32) * (0.5 + 0.5 * amount);
      const night = lightState.current?.night ?? 0;
      u.uColor.value.setRGB(0.62, 0.64, 0.68).multiplyScalar(1 - 0.75 * night);
      (lines.geometry as THREE.BufferGeometry).setDrawRange(0, Math.round(quality.rainDrops * 2 * (0.4 + 0.6 * amount)));
    }
    if (lines.visible) u.uCam.value.copy(camera.position);
  });
  return <primitive object={lines} />;
}
