/**
 * Place names in the world: towns, villages, churches, castles, peaks and
 * viewpoints from the bundle's POIs (landmarks.ts picks which), drawn as
 * small paper labels in the book serif of the warm-atlas identity, standing
 * on a hairline above the place. Colours come from the theme tokens
 * (`--card`, `--card-foreground`, `--border`), never hard-coded. Labels keep a
 * constant on-screen size, fade in and out, and hide behind hills
 * (heightfield line-of-sight).
 */

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import type { Heightfield } from '@/lib/world/heightfield';
import type { WorldPoi } from '@/lib/world/manifest';

import { labelText, pickLabels, type LabelPick } from './landmarks';
import type { ThreeQuality } from './quality';
import type { SceneWorld } from './worldScene';

const FONT_FAMILY = "'Source Serif 4 Variable', 'Iowan Old Style', Charter, 'Noto Serif', Georgia, serif";

let fontLoad: Promise<void> | null = null;
/** Load the display serif once (public/fonts); labels fall back to Georgia until it's in. */
function loadDisplayFont(): Promise<void> {
  if (fontLoad) return fontLoad;
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return (fontLoad = Promise.resolve());
  const base = (import.meta as { env?: Record<string, string | undefined> }).env?.BASE_URL ?? '/';
  const url = `${base.endsWith('/') ? base : `${base}/`}fonts/source-serif-4-latin-wght-normal.woff2`;
  const face = new FontFace('Source Serif 4 Variable', `url(${url}) format('woff2')`, { weight: '200 900' });
  fontLoad = face
    .load()
    .then((f) => {
      document.fonts.add(f);
    })
    .catch(() => undefined);
  return fontLoad;
}

/** A theme token (`--name: H S% L%`) as a CSS colour, or the fallback. */
function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(raw) ? `hsl(${raw.replace(/\s+/g, ' ').split(' ').join(', ')})` : fallback;
}

/** Label height in CSS pixels at the tier's resolution, by rank. */
const LABEL_PX: Readonly<Record<number, number>> = { 3: 30, 2: 24, 1: 21 };
const SCALE = 2;

interface LabelSprite {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  aspect: number;
  pick: LabelPick;
  opacity: number;
  target: number;
  /** World anchor (three.js) of the label's foot. */
  anchor: THREE.Vector3;
  ground: THREE.Vector3;
}

function drawLabel(p: LabelPick): { canvas: HTMLCanvasElement; aspect: number } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const px = (LABEL_PX[p.rank] ?? 21) * SCALE;
  const font = `${p.rank === 3 ? 600 : 500} ${Math.round(px * 0.62)}px ${FONT_FAMILY}`;
  ctx.font = font;
  const text = labelText(p.poi);
  const padX = px * 0.42;
  const w = Math.ceil(ctx.measureText(text).width + padX * 2);
  const h = Math.ceil(px);
  canvas.width = w;
  canvas.height = h;
  const r = h * 0.22;
  ctx.font = font;
  ctx.fillStyle = token('--card', '#fbf8f2');
  ctx.strokeStyle = token('--border', '#d8cfc0');
  ctx.lineWidth = SCALE;
  ctx.beginPath();
  ctx.roundRect(SCALE / 2, SCALE / 2, w - SCALE, h - SCALE, r);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = token('--card-foreground', '#2a2018');
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, h / 2 + px * 0.03);
  return { canvas, aspect: w / h };
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

/** Anchor height above the POI's ground: towns float higher so the label clears the roofs. */
function liftFor(p: WorldPoi): number {
  return p.kind === 'town' ? 70 : p.kind === 'peak' ? 25 : 34;
}

export function Landmarks({ sceneWorld, quality }: { sceneWorld: SceneWorld; quality: ThreeQuality }) {
  const size = useThree((s) => s.size);
  const state = useMemo(
    () => ({
      labels: new Map<number, LabelSprite>(),
      nextPick: 0,
      ink: new THREE.Color(),
      fontReady: false,
      group: new THREE.Group(),
      fwd: new THREE.Vector3(),
    }),
    [],
  );
  const leaders = useMemo(() => {
    const max = Math.max(1, quality.maxLabels);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 2 * 4), 4));
    g.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false });
    const l = new THREE.LineSegments(g, mat);
    l.name = 'landmark-leaders';
    l.frustumCulled = false;
    return l;
  }, [quality.maxLabels]);

  useEffect(() => {
    state.group.name = 'landmarks';
    let alive = true;
    void loadDisplayFont().then(() => {
      if (!alive) return;
      state.fontReady = true;
      // Redraw labels made with the fallback font.
      for (const l of state.labels.values()) {
        const d = drawLabel(l.pick);
        if (!d) continue;
        l.texture.image = d.canvas;
        l.texture.needsUpdate = true;
        l.aspect = d.aspect;
      }
    });
    return () => {
      alive = false;
      for (const l of state.labels.values()) {
        l.texture.dispose();
        l.sprite.material.dispose();
      }
      state.labels.clear();
      leaders.geometry.dispose();
      (leaders.material as THREE.Material).dispose();
    };
  }, [state, leaders]);

  useFrame(({ camera, clock }, delta) => {
    if (quality.maxLabels <= 0) return;
    const hf = sceneWorld.heightfield;
    const pois = sceneWorld.world.manifest.pois;
    const t = clock.elapsedTime;
    if (t >= state.nextPick) {
      state.nextPick = t + 0.5;
      // Theme colour read twice a second, not per frame (getComputedStyle forces a style pass).
      state.ink.set(token('--card-foreground', '#2a2018'));
      camera.getWorldDirection(state.fwd);
      const fl = Math.hypot(state.fwd.x, state.fwd.z) || 1;
      const picks = pickLabels(pois, camera.position.x, -camera.position.z, state.fwd.x / fl, -state.fwd.z / fl, quality.maxLabels);
      const keep = new Set(picks.map((p) => p.index));
      for (const [i, l] of state.labels) if (!keep.has(i)) l.target = 0;
      for (const p of picks) {
        let l = state.labels.get(p.index);
        if (!l) {
          const d = drawLabel(p);
          if (!d) continue;
          const texture = new THREE.CanvasTexture(d.canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.generateMipmaps = false;
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, fog: false, opacity: 0, toneMapped: false }),
          );
          sprite.center.set(0.5, 0);
          sprite.renderOrder = 10;
          sprite.name = `label-${p.poi.name}`;
          const groundY = hf.sampleHeight(p.poi.x, p.poi.y);
          l = {
            sprite,
            texture,
            aspect: d.aspect,
            pick: p,
            opacity: 0,
            target: 0,
            anchor: new THREE.Vector3(p.poi.x, groundY + liftFor(p.poi), -p.poi.y),
            ground: new THREE.Vector3(p.poi.x, groundY + 2, -p.poi.y),
          };
          state.labels.set(p.index, l);
          state.group.add(sprite);
        }
        l.pick = p;
        l.target = lineOfSight(hf, camera.position, l.anchor) ? 1 : 0;
      }
    }
    // Fade, size (constant pixels), leaders.
    const cam = camera as THREE.PerspectiveCamera;
    const pxToWorld = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, size.height);
    const pos = leaders.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = leaders.geometry.getAttribute('color') as THREE.BufferAttribute;
    const ink = state.ink;
    let n = 0;
    for (const [i, l] of state.labels) {
      l.opacity += (l.target - l.opacity) * Math.min(1, delta * 4);
      if (l.target === 0 && l.opacity < 0.02) {
        state.group.remove(l.sprite);
        l.texture.dispose();
        l.sprite.material.dispose();
        state.labels.delete(i);
        continue;
      }
      const dist = camera.position.distanceTo(l.anchor);
      const hPx = LABEL_PX[l.pick.rank] ?? 21;
      const hWorld = hPx * pxToWorld * dist;
      l.sprite.scale.set(hWorld * l.aspect, hWorld, 1);
      l.sprite.position.copy(l.anchor);
      l.sprite.material.opacity = l.opacity * 0.96;
      if (n < quality.maxLabels) {
        pos.setXYZ(n * 2, l.ground.x, l.ground.y, l.ground.z);
        pos.setXYZ(n * 2 + 1, l.anchor.x, l.anchor.y, l.anchor.z);
        for (const k of [0, 1]) colAttr.setXYZW(n * 2 + k, ink.r, ink.g, ink.b, l.opacity * 0.55);
        n++;
      }
    }
    pos.needsUpdate = true;
    colAttr.needsUpdate = true;
    leaders.geometry.setDrawRange(0, n * 2);
  });

  if (quality.maxLabels <= 0) return null;
  return (
    <>
      <primitive object={state.group} />
      <primitive object={leaders} />
    </>
  );
}
