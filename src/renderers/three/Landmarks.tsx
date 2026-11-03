/**
 * Place pins in the world: towns, villages, churches, castles, peaks and
 * viewpoints from the bundle's POIs (landmarks.ts picks which), drawn as
 * plain map pins standing on a hairline above the place. No text: names
 * belong to the minimap, finish card and postcards, never floating in the
 * world. Colours come from the theme tokens (`--card`, `--card-foreground`),
 * never hard-coded. Pins keep a constant on-screen size by rank, fade in and
 * out, hide behind hills (heightfield line-of-sight), and are decluttered
 * on screen every frame so two pins can never overlap.
 */

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import type { Heightfield } from '@/lib/world/heightfield';
import type { WorldPoi } from '@/lib/world/manifest';

import { PIN_ASPECT, PIN_PX, declutterPins, pickPins, pinPriority, pinRect, type PinPick, type PinRect } from './landmarks';
import type { ThreeQuality } from './quality';
import type { SceneWorld } from './worldScene';

/** A theme token (`--name: H S% L%`) as a CSS colour, or the fallback. */
function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(raw) ? `hsl(${raw.replace(/\s+/g, ' ').split(' ').join(', ')})` : fallback;
}

/** Texture pixels per CSS pixel of the largest pin. */
const TEX_SCALE = 3;

/**
 * One map pin (round head, point at the bottom centre, a hole in the head):
 * fill `--card-foreground`, rim and hole `--card`, so it reads on day
 * fields and the night sky alike. Drawn once, shared by every pin.
 */
function drawPin(fill: string, rim: string): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const h = Math.ceil(PIN_PX[3] * TEX_SCALE);
  const w = Math.ceil(h * PIN_ASPECT);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const line = TEX_SCALE * 1.4;
  const r = w / 2 - line;
  const cx = w / 2;
  const cy = r + line;
  const tipY = h - line;
  // Tangents from the tip to the head circle.
  const d = tipY - cy;
  const a = Math.asin(Math.min(1, r / d));
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.arc(cx, cy, r, Math.PI / 2 + a, Math.PI / 2 - a);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = line;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = rim;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.36, 0, Math.PI * 2);
  ctx.fillStyle = rim;
  ctx.fill();
  return canvas;
}

interface PinSprite {
  sprite: THREE.Sprite;
  pick: PinPick;
  opacity: number;
  /** Picked and in line of sight (before the on-screen declutter). */
  wanted: boolean;
  /** World anchor (three.js) of the pin's tip. */
  anchor: THREE.Vector3;
  ground: THREE.Vector3;
}

/** Is the straight line from the camera to `to` above the terrain? (12 samples) */
function lineOfSight(hf: Heightfield, from: THREE.Vector3, to: THREE.Vector3): boolean {
  for (let i = 1; i < 12; i++) {
    const t = i / 12;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const y = from.y + (to.y - from.y) * t;
    if (hf.sampleHeight(x, -z) > y + 2) return false;
  }
  return true;
}

/** Anchor height above the POI's ground: towns stand higher so the pin clears the roofs. */
function liftFor(p: WorldPoi): number {
  return p.kind === 'town' ? 70 : p.kind === 'peak' ? 25 : 34;
}

export function Landmarks({ sceneWorld, quality }: { sceneWorld: SceneWorld; quality: ThreeQuality }) {
  const size = useThree((s) => s.size);
  const state = useMemo(() => {
    const texture = new THREE.CanvasTexture(typeof document === 'undefined' ? undefined : document.createElement('canvas'));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return {
      pins: new Map<number, PinSprite>(),
      nextPick: 0,
      ink: new THREE.Color(),
      palette: '',
      texture,
      group: new THREE.Group(),
      fwd: new THREE.Vector3(),
      ndc: new THREE.Vector3(),
    };
  }, []);
  const leaders = useMemo(() => {
    const max = Math.max(1, quality.maxPins);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 2 * 4), 4));
    g.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false });
    const l = new THREE.LineSegments(g, mat);
    l.name = 'landmark-leaders';
    l.frustumCulled = false;
    return l;
  }, [quality.maxPins]);

  useEffect(() => {
    state.group.name = 'landmarks';
    return () => {
      for (const p of state.pins.values()) p.sprite.material.dispose();
      state.pins.clear();
      state.texture.dispose();
      leaders.geometry.dispose();
      (leaders.material as THREE.Material).dispose();
    };
  }, [state, leaders]);

  useFrame(({ camera, clock }, delta) => {
    if (quality.maxPins <= 0) return;
    const hf = sceneWorld.heightfield;
    const pois = sceneWorld.world.manifest.pois;
    const t = clock.elapsedTime;
    if (t >= state.nextPick) {
      state.nextPick = t + 0.5;
      // Theme colours read twice a second, not per frame (getComputedStyle forces a style pass).
      const fill = token('--card-foreground', '#2a2018');
      const rim = token('--card', '#fbf8f2');
      if (`${fill}|${rim}` !== state.palette) {
        const canvas = drawPin(fill, rim);
        if (canvas) {
          state.palette = `${fill}|${rim}`;
          state.texture.image = canvas;
          state.texture.needsUpdate = true;
        }
      }
      state.ink.set(fill);
      camera.getWorldDirection(state.fwd);
      const fl = Math.hypot(state.fwd.x, state.fwd.z) || 1;
      const picks = pickPins(pois, camera.position.x, -camera.position.z, state.fwd.x / fl, -state.fwd.z / fl, quality.maxPins);
      const keep = new Set(picks.map((p) => p.index));
      for (const [i, p] of state.pins) if (!keep.has(i)) p.wanted = false;
      for (const pick of picks) {
        let p = state.pins.get(pick.index);
        if (!p) {
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: state.texture, transparent: true, depthWrite: false, depthTest: false, fog: false, opacity: 0, toneMapped: false }),
          );
          sprite.center.set(0.5, 0);
          sprite.renderOrder = 10;
          sprite.name = `pin-${pick.index}`;
          const groundY = hf.sampleHeight(pick.poi.x, pick.poi.y);
          p = {
            sprite,
            pick,
            opacity: 0,
            wanted: false,
            anchor: new THREE.Vector3(pick.poi.x, groundY + liftFor(pick.poi), -pick.poi.y),
            ground: new THREE.Vector3(pick.poi.x, groundY + 2, -pick.poi.y),
          };
          state.pins.set(pick.index, p);
          state.group.add(sprite);
        }
        p.pick = pick;
        p.wanted = lineOfSight(hf, camera.position, p.anchor);
      }
    }
    // Declutter on screen this frame (strongest first), then fade, size, leaders.
    const cam = camera as THREE.PerspectiveCamera;
    const order = [...state.pins.values()].sort((a, b) => pinPriority(a.pick, b.pick));
    // Every pin still on screen takes part (fading ones too), so whatever is
    // drawn this frame never overlaps; a pin that would is hidden at once.
    const rects: (PinRect | null)[] = order.map((p) => {
      const v = state.ndc.copy(p.anchor).project(cam);
      if (v.z < -1 || v.z > 1) return null;
      return pinRect(((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height, p.pick.rank);
    });
    const show = declutterPins(rects);
    const pxToWorld = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, size.height);
    const pos = leaders.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = leaders.geometry.getAttribute('color') as THREE.BufferAttribute;
    const ink = state.ink;
    let n = 0;
    order.forEach((p, k) => {
      if (show[k]) p.opacity += ((p.wanted ? 1 : 0) - p.opacity) * Math.min(1, delta * 4);
      else p.opacity = 0;
      if (!p.wanted && p.opacity < 0.02) {
        state.group.remove(p.sprite);
        p.sprite.material.dispose();
        state.pins.delete(p.pick.index);
        return;
      }
      const hWorld = (PIN_PX[p.pick.rank] ?? PIN_PX[1]) * pxToWorld * camera.position.distanceTo(p.anchor);
      p.sprite.scale.set(hWorld * PIN_ASPECT, hWorld, 1);
      p.sprite.position.copy(p.anchor);
      p.sprite.material.opacity = p.opacity * 0.96;
      p.sprite.visible = p.opacity > 0.01;
      if (p.sprite.visible && n < quality.maxPins) {
        pos.setXYZ(n * 2, p.ground.x, p.ground.y, p.ground.z);
        pos.setXYZ(n * 2 + 1, p.anchor.x, p.anchor.y, p.anchor.z);
        for (const j of [0, 1]) colAttr.setXYZW(n * 2 + j, ink.r, ink.g, ink.b, p.opacity * 0.55);
        n++;
      }
    });
    pos.needsUpdate = true;
    colAttr.needsUpdate = true;
    leaders.geometry.setDrawRange(0, n * 2);
  });

  if (quality.maxPins <= 0) return null;
  return (
    <>
      <primitive object={state.group} />
      <primitive object={leaders} />
    </>
  );
}
