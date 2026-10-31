/**
 * Sky gradient dome, sun light (direction from the real sun at the route,
 * or the mood's pinned sun), hemisphere fill and distance fog matched to
 * the horizon so far terrain melts into the sky. The sun's shadow camera
 * rides along with the rider.
 */

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import type { ThreeQuality } from './quality';
import { fogDensity, lowSunWarmth, moodLook, sunDirection, sunFor } from './skyModel';
import type { RideFrame } from './worldScene';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uWarmth;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  float t = pow(clamp(up, 0.0, 1.0), 0.45);
  vec3 col = mix(uHorizon, uZenith, t);
  // Below the horizon: stay at the horizon haze (fog colour) so the seam never shows.
  col = mix(col, uHorizon, smoothstep(0.0, -0.08, up));
  float s = max(dot(d, uSunDir), 0.0);
  // Warm forward-scatter around a low sun, a soft halo, and the disc.
  col += uSunColor * (pow(s, 6.0) * (0.12 + 0.35 * uWarmth) + pow(s, 64.0) * 0.35 + smoothstep(0.9993, 0.9997, s) * 6.0);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const lin = (c: readonly [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

export function Sky({
  frame,
  mood,
  lat,
  lon,
  quality,
}: {
  frame: RideFrame;
  mood: string;
  lat: number;
  lon: number;
  quality: ThreeQuality;
}) {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const look = moodLook(mood);

  const dome = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uWarmth: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
    mesh.name = 'sky';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    return mesh;
  }, []);

  const lights = useMemo(() => {
    const sun = new THREE.DirectionalLight('#ffffff', 3);
    sun.name = 'sun';
    const hemi = new THREE.HemisphereLight('#ffffff', '#444444', 1);
    hemi.name = 'sky-light';
    return { sun, hemi };
  }, []);

  // Mood + sun position: recomputed on mood change and once a minute (real sun).
  const sunState = useMemo(() => ({ dir: new THREE.Vector3(0, 1, 0), nextAtMs: 0 }), []);

  useEffect(() => {
    const u = (dome.material as THREE.ShaderMaterial).uniforms;
    const horizon = lin(look.horizon);
    u.uZenith.value.copy(lin(look.zenith));
    u.uHorizon.value.copy(horizon);
    scene.fog = new THREE.FogExp2(horizon.clone(), fogDensity(quality.viewDistanceM, look.fogFar));
    scene.background = horizon.clone();
    lights.hemi.color.copy(lin(look.zenith)).lerp(new THREE.Color(1, 1, 1), 0.45);
    lights.hemi.groundColor.copy(lin(look.ground));
    lights.hemi.intensity = look.skyIntensity;
    gl.toneMappingExposure = look.exposure;
    sunState.nextAtMs = 0;
    return () => {
      scene.fog = null;
      scene.background = null;
    };
  }, [look, scene, gl, quality.viewDistanceM, dome, lights, sunState]);

  useEffect(() => {
    const { sun } = lights;
    sun.castShadow = quality.shadows;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = -6;
    cam.right = 6;
    cam.top = 6;
    cam.bottom = -6;
    cam.near = 1;
    cam.far = 120;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }, [lights, quality.shadows, quality.shadowMapSize]);

  useEffect(
    () => () => {
      dome.geometry.dispose();
      (dome.material as THREE.Material).dispose();
      lights.sun.shadow.map?.dispose();
      lights.sun.dispose();
      lights.hemi.dispose();
    },
    [dome, lights],
  );

  useFrame(({ camera }) => {
    const now = Date.now();
    if (now >= sunState.nextAtMs) {
      sunState.nextAtMs = now + 60_000;
      const s = sunFor(look, new Date(now), lat, lon);
      const [x, y, z] = sunDirection(s.azimuth, s.altitude);
      sunState.dir.set(x, y, z);
      const warmth = lowSunWarmth(s.altitude);
      const sunColor = lin(look.sun).lerp(new THREE.Color(1, 0.55, 0.25), warmth * 0.6);
      lights.sun.color.copy(sunColor);
      lights.sun.intensity = look.sunIntensity * (1 - 0.35 * warmth);
      const u = (dome.material as THREE.ShaderMaterial).uniforms;
      u.uSunDir.value.copy(sunState.dir);
      u.uSunColor.value.copy(sunColor);
      u.uWarmth.value = warmth;
      const horizon = lin(look.horizon).lerp(new THREE.Color(1, 0.72, 0.5), warmth * 0.35);
      u.uHorizon.value.copy(horizon);
      if (scene.fog) scene.fog.color.copy(horizon);
      if (scene.background instanceof THREE.Color) scene.background.copy(horizon);
    }
    // The dome sits just inside the far plane, centred on the camera.
    const cam = camera as THREE.PerspectiveCamera;
    dome.position.copy(camera.position);
    dome.scale.setScalar(cam.far * 0.95);
    // Sun and its shadow camera follow the rider.
    const p = frame.placement?.position;
    if (p) {
      lights.sun.target.position.set(p.x, p.y, p.z);
      lights.sun.position.set(p.x + sunState.dir.x * 60, p.y + sunState.dir.y * 60, p.z + sunState.dir.z * 60);
      lights.sun.target.updateMatrixWorld();
    }
  });

  return (
    <>
      <primitive object={dome} />
      <primitive object={lights.sun} />
      <primitive object={lights.sun.target} />
      <primitive object={lights.hemi} />
    </>
  );
}
