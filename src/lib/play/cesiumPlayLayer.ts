/**
 * Cesium renderer for Play mode: postcard billboards along the route and the
 * riding buddy's avatar. Implements the renderer-agnostic WorldLayer; all game
 * rules live in ./postcards and ./buddy.
 *
 * Lifecycle: create per route, update once per frame from preRender, dispose
 * on route change, toggle off and viewer destroy. Everything added to
 * viewer.entities is removed in dispose().
 */

import * as Cesium from 'cesium';
import type { Route } from '@/types';
import type { AvatarColors } from '@/lib/avatarConfig';
import { createAvatar, type Avatar } from '@/lib/avatar';
import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { sampleGroundHeight } from '@/lib/cesiumUtils';
import type { RideFrame, WorldLayer } from '@/lib/world/worldLayer';
import { collectedAt, metresToNext, placePostcards, type Postcard } from '@/lib/play/postcards';
import {
  BUDDY_SIDE_M,
  buddyLine,
  buddyTargetGap,
  easeGap,
  offsetSideways,
  type BuddyRide,
} from '@/lib/play/buddy';
import { usePlayStore } from '@/stores/playStore';

/** Height of a postcard above the road, metres. */
const POSTCARD_HEIGHT_M = 2.4;
/** How long the pickup animation runs before the card hides, ms. */
const PICKUP_ANIM_MS = 700;
/** The "next in" figure updates in steps of this many metres. */
const TO_NEXT_STEP_M = 50;
/** Re-seat upcoming cards on the rendered ground when they're this close. */
const GROUND_REFINE_M = 400;
const GROUND_REFINE_EVERY_MS = 500;

export interface BuddyConfig {
  name: string;
  colors: AvatarColors;
}

export interface PlayLayer extends WorldLayer {
  readonly postcards: readonly Postcard[];
  /** Attach the buddy's recorded ride once it has loaded (or null for none). */
  setBuddyRide: (ride: BuddyRide | null) => void;
}

// ---- Token colours ---------------------------------------------------------

/** Read a design token (an `H S% L%` triplet in index.css) as a CSS colour. */
function tokenCss(name: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const [h, s, l] = raw.split(/\s+/);
  return h && s && l ? `hsl(${h}, ${s}, ${l})` : fallback;
}

/**
 * A small postcard drawn in code: card face, a stamp in the accent colour and
 * two address lines. Returns undefined where canvas isn't available (tests),
 * in which case the billboard falls back to a point.
 */
function drawPostcard(): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return undefined;
  const w = 96;
  const h = 68;
  canvas.width = w;
  canvas.height = h;
  // Paper and ink are scene colours (the card is a world object, so it stays
  // light in both themes); the stamp takes the app's accent token.
  const card = 'hsl(40, 33%, 96%)';
  const ink = 'hsl(220, 42%, 8%)';
  const accent = tokenCss('--accent', 'hsl(158, 80%, 42%)');
  // Face with a soft outline so it reads against sky and road.
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 10);
  ctx.fill();
  ctx.fillStyle = card;
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 7);
  ctx.fill();
  // Stamp.
  ctx.fillStyle = accent;
  ctx.fillRect(w - 32, 12, 18, 22);
  // Address lines.
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.55;
  ctx.fillRect(14, 40, 44, 4);
  ctx.fillRect(14, 50, 32, 4);
  ctx.globalAlpha = 1;
  return canvas;
}

// ---- Layer -----------------------------------------------------------------

export function createCesiumPlayLayer(
  viewer: Cesium.Viewer,
  route: Route,
  buddy: BuddyConfig | null,
): PlayLayer {
  const postcards = placePostcards(route.totalDistance);
  const image = drawPostcard();
  const pickedAt: number[] = postcards.map(() => 0);
  const entities: Cesium.Entity[] = [];
  let clockMs = 0;

  // Cards sit at the route elevation first (like the rider's avatar when no
  // ground is sampled), then get re-seated on the rendered ground as the
  // rider approaches and nearby tiles have loaded. Clamping to the globe
  // would bury them when the route's DEM height and the globe disagree
  // (no-token map fallback renders an ellipsoid at 0 m).
  const cardPoints = postcards.map((card) => sampleRouteAtDistance(route, card.distanceM));
  const seated: boolean[] = postcards.map(() => false);
  let lastRefineMs = -Infinity;

  postcards.forEach((card, i) => {
    const p = cardPoints[i];
    const position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.ele + POSTCARD_HEIGHT_M);
    const phase = i * 1.7;
    const scaleOf = () => {
      const since = pickedAt[i] ? clockMs - pickedAt[i] : 0;
      return pickedAt[i] ? 1 + Math.min(1, since / PICKUP_ANIM_MS) * 0.8 : 1;
    };
    const alphaOf = () => {
      const since = pickedAt[i] ? clockMs - pickedAt[i] : 0;
      return pickedAt[i] ? Math.max(0, 1 - since / PICKUP_ANIM_MS) : 1;
    };
    const entity = viewer.entities.add({
      name: `Postcard ${card.index}`,
      position,
      billboard: image
        ? {
            image,
            width: 48,
            height: 34,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            scaleByDistance: new Cesium.NearFarScalar(15, 1.6, 900, 0.45),
            // Only the next one or two: a row of cards on the horizon is clutter.
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1200),
            // Gentle bob so it reads as something to pick up, not a sign.
            pixelOffset: new Cesium.CallbackProperty(
              () => new Cesium.Cartesian2(0, -4 * Math.sin(clockMs / 600 + phase)),
              false,
            ),
            scale: new Cesium.CallbackProperty(scaleOf, false),
            color: new Cesium.CallbackProperty(
              () => Cesium.Color.WHITE.withAlpha(alphaOf()),
              false,
            ),
            disableDepthTestDistance: 40,
          }
        : undefined,
      point: image
        ? undefined
        : { pixelSize: 12 },
    });
    entities.push(entity);
  });

  // ---- Buddy ----
  let buddyAvatar: Avatar | null = null;
  let buddyRide: BuddyRide | null = null;
  let gap = 0;
  let lastBuddyDist = 0;
  if (buddy) {
    buddyAvatar = createAvatar(viewer, { colors: buddy.colors });
    // Place it before the first render: avatar parts have no position until
    // the first update, and Cesium can't resolve an unplaced entity.
    const start = sampleRouteAtDistance(route, 0);
    const heading = headingAt(route, 0);
    const side = offsetSideways(start.lat, start.lon, heading, BUDDY_SIDE_M);
    buddyAvatar.update({
      lon: side.lon, lat: side.lat, ele: start.ele, heading, speed: 0, cadence: 0, grade: 0, dt: 0,
    });
  }

  let collected = 0;
  let lastToNextBucket = -1;
  const store = usePlayStore.getState();
  store.start(postcards.length, buddy ? buddyLine(buddy.name, null) : null);
  store.progress(0, metresToNext(postcards, 0, 0), false);

  let disposed = false;

  return {
    id: 'cesium-play',
    postcards,

    setBuddyRide(ride) {
      buddyRide = ride;
      if (buddy && !disposed) usePlayStore.getState().setBuddyLine(buddyLine(buddy.name, ride));
    },

    update(frame: RideFrame) {
      if (disposed || viewer.isDestroyed()) return;
      clockMs += frame.dt * 1000;

      // Postcards.
      const now = Math.max(collected, collectedAt(postcards, frame.distanceM));
      const picked = now > collected;
      for (let i = collected; i < now; i++) pickedAt[i] = clockMs || 1;
      collected = now;
      for (let i = 0; i < entities.length; i++) {
        if (pickedAt[i] && clockMs - pickedAt[i] > PICKUP_ANIM_MS) entities[i].show = false;
      }
      if (clockMs - lastRefineMs >= GROUND_REFINE_EVERY_MS) {
        lastRefineMs = clockMs;
        for (let i = collected; i < postcards.length; i++) {
          if (postcards[i].distanceM - frame.distanceM > GROUND_REFINE_M) break;
          if (seated[i]) continue;
          const p = cardPoints[i];
          const ground = sampleGroundHeight(viewer.scene, p.lon, p.lat);
          if (ground === undefined || !Number.isFinite(ground)) continue;
          seated[i] = true;
          entities[i].position = new Cesium.ConstantPositionProperty(
            Cesium.Cartesian3.fromDegrees(p.lon, p.lat, ground + POSTCARD_HEIGHT_M),
          );
        }
      }
      const toNext = metresToNext(postcards, collected, frame.distanceM);
      const bucket = toNext === null ? -2 : Math.ceil(toNext / TO_NEXT_STEP_M);
      if (picked || bucket !== lastToNextBucket) {
        lastToNextBucket = bucket;
        usePlayStore
          .getState()
          .progress(collected, toNext === null ? null : bucket * TO_NEXT_STEP_M, picked);
      }

      // Buddy.
      if (buddyAvatar) {
        const elapsedSec = frame.elapsedMs / 1000;
        gap = easeGap(gap, buddyTargetGap(elapsedSec, frame.distanceM, buddyRide), frame.dt);
        const dist = Math.max(0, Math.min(frame.routeLengthM, frame.distanceM + gap));
        const p = sampleRouteAtDistance(route, dist);
        const heading = headingAt(route, dist);
        const side = offsetSideways(p.lat, p.lon, heading, BUDDY_SIDE_M);
        const speed = frame.dt > 0 ? Math.max(0, (dist - lastBuddyDist) / frame.dt) : frame.speedMs;
        lastBuddyDist = dist;
        buddyAvatar.update({
          lon: side.lon,
          lat: side.lat,
          ele: p.ele,
          heading,
          speed,
          cadence: 0,
          grade: frame.gradePct,
          dt: frame.dt,
        });
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (!viewer.isDestroyed()) {
        for (const e of entities) viewer.entities.remove(e);
        buddyAvatar?.dispose();
      }
      entities.length = 0;
      buddyAvatar = null;
      usePlayStore.getState().stop();
    },
  };
}
