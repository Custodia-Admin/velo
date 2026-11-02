/**
 * The stylized GLTF rider (public/models/velo-rider.glb, made by
 * scripts/gen-rider-glb.mjs) in the rider's own colourway: wheels roll with
 * speed, cranks turn with cadence, legs follow the pedals (two-bone IK), the
 * bike pitches with the ground under its wheels and leans into corners.
 * Pace bots ride the same model in their BOT_COLORWAYS kits.
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import type { AvatarColors } from '@/lib/avatarConfig';
import { BOT_COLORWAYS } from '@/lib/paceBots';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Route } from '@/types';
import { createBotDriverMemo, driveBotPose } from './rideDriver';
import {
  RIDER_RIG,
  estimatedCadence,
  legPose,
  modelYaw,
  placeRider,
  type RiderPlacement,
} from './riderRig';
import type { RideFrame, SceneWorld } from './worldScene';

export const RIDER_MODEL_URL = `${import.meta.env.BASE_URL ?? '/'}models/velo-rider.glb`;

const COLOR_ROLES: (keyof AvatarColors)[] = ['frame', 'wheel', 'kit', 'skin', 'helmet', 'accent'];

export interface RiderDrive {
  placement: RiderPlacement;
  speed: number;
  cadence: number;
  lean: number;
}

interface RiderParts {
  root: THREE.Group;
  materials: Map<string, THREE.MeshStandardMaterial>;
  wheelFront?: THREE.Object3D;
  wheelRear?: THREE.Object3D;
  crank?: THREE.Object3D;
  legs: { side: 1 | -1; thigh?: THREE.Object3D; shin?: THREE.Object3D; foot?: THREE.Object3D }[];
}

/** Deep-clone the model with its own materials (so colourways don't leak between riders). */
export function cloneRider(source: THREE.Object3D, castShadow: boolean): RiderParts {
  const root = new THREE.Group();
  root.name = 'rider';
  const model = source.clone(true);
  root.add(model);
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = mesh.material as THREE.MeshStandardMaterial;
    let mine = materials.get(m.name);
    if (!mine) {
      mine = m.clone();
      materials.set(m.name, mine);
    }
    mesh.material = mine;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
  });
  const find = (name: string) => model.getObjectByName(name) ?? undefined;
  return {
    root,
    materials,
    wheelFront: find('wheelFront'),
    wheelRear: find('wheelRear'),
    crank: find('crank'),
    legs: [
      { side: 1, thigh: find('thighR'), shin: find('shinR'), foot: find('footR') },
      { side: -1, thigh: find('thighL'), shin: find('shinL'), foot: find('footL') },
    ],
  };
}

export function applyColors(parts: RiderParts, colors: AvatarColors) {
  for (const role of COLOR_ROLES) parts.materials.get(role)?.color.set(colors[role]);
}

/** Pose the rig for this frame. `state` carries wheel and crank angles between frames. */
export function poseRider(parts: RiderParts, drive: RiderDrive, state: { wheel: number; crank: number }, dt: number) {
  const { placement } = drive;
  parts.root.position.set(placement.position.x, placement.position.y, placement.position.z);
  parts.root.rotation.set(drive.lean, modelYaw(placement.heading), placement.pitch, 'YZX');
  state.wheel -= (drive.speed / RIDER_RIG.wheelRadius) * dt;
  state.crank -= ((drive.cadence / 60) * Math.PI * 2) * dt;
  parts.wheelFront?.rotation.set(0, 0, state.wheel);
  parts.wheelRear?.rotation.set(0, 0, state.wheel);
  parts.crank?.rotation.set(0, 0, state.crank);
  for (const leg of parts.legs) {
    const p = legPose(state.crank, leg.side);
    leg.thigh?.rotation.set(0, 0, p.thighAngle);
    leg.shin?.position.set(p.knee[0], p.knee[1], 0);
    leg.shin?.rotation.set(0, 0, p.shinAngle);
    leg.foot?.position.set(p.ankle[0], p.ankle[1], 0);
    leg.foot?.rotation.set(0, 0, -0.12 + 0.18 * Math.sin(state.crank + (leg.side === 1 ? 0 : Math.PI)));
  }
}

export function RiderModel({
  colors,
  drive,
  castShadow = false,
}: {
  colors: AvatarColors;
  /** Called every frame with the frame time (s, clamped); null hides the rider. */
  drive: (dt: number) => RiderDrive | null;
  castShadow?: boolean;
}) {
  const gltf = useGLTF(RIDER_MODEL_URL, false, false);
  const parts = useMemo(() => cloneRider(gltf.scene, castShadow), [gltf, castShadow]);
  const anim = useMemo(() => ({ wheel: 0, crank: 0 }), []);
  useEffect(() => applyColors(parts, colors), [parts, colors]);
  useEffect(
    () => () => {
      for (const m of parts.materials.values()) m.dispose();
    },
    [parts],
  );
  useFrame((_, delta) => {
    const dt = Math.min(0.1, Math.max(0, delta));
    const d = drive(dt);
    parts.root.visible = d !== null;
    if (d) poseRider(parts, d, anim, dt);
  });
  return <primitive object={parts.root} />;
}

/** The live rider, from the frame the ride driver computed. */
export function LiveRider({ frame, castShadow }: { frame: RideFrame; castShadow: boolean }) {
  const colors = useSettingsStore((s) => s.avatar);
  const drive = useMemo(
    () => (): RiderDrive | null =>
      frame.valid && frame.placement
        ? { placement: frame.placement, speed: frame.speed, cadence: frame.cadence, lean: frame.lean }
        : null,
    [frame],
  );
  return <RiderModel colors={colors} drive={drive} castShadow={castShadow} />;
}

function BotRider({ sceneWorld, route, index }: { sceneWorld: SceneWorld; route: Route; index: number }) {
  const memo = useMemo(() => createBotDriverMemo(), []);
  const drive = useMemo(
    () =>
      (dt: number): RiderDrive | null => {
        const bot = useRideStore.getState().paceBots[index];
        if (!bot) {
          memo.yaw.reset();
          return null;
        }
        const s = bot.state;
        const { heading, lean } = driveBotPose(memo, route, s, dt);
        const placement = placeRider(sceneWorld, { lat: s.lat, lon: s.lon, heading });
        return { placement, speed: s.speed, cadence: estimatedCadence(s.speed), lean };
      },
    [sceneWorld, route, index, memo],
  );
  return <RiderModel colors={BOT_COLORWAYS[index % BOT_COLORWAYS.length]} drive={drive} />;
}

export function PaceBots({ sceneWorld, route }: { sceneWorld: SceneWorld; route: Route }) {
  const count = useRideStore((s) => s.paceBots.length);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <BotRider key={i} sceneWorld={sceneWorld} route={route} index={i} />
      ))}
    </>
  );
}

/** Start fetching the model as soon as the renderer chunk loads. */
export function preloadRider() {
  useGLTF.preload(RIDER_MODEL_URL, false, false);
}
