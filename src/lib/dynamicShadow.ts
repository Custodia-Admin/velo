/**
 * dynamicShadow.ts
 *
 * Ground shadow under the rider avatar: a flat dark ellipse just above the
 * ground, sized and oriented by the sun's current azimuth/altitude.
 *
 * Low sun (altitude ≈ 10°) → long shadow cast away from the sun.
 * High sun (altitude ≈ 90°) → small shadow directly below the rider.
 *
 * Implementation: one Primitive (a unit sphere squashed into a disc) whose
 * modelMatrix carries position, size and direction. Its geometry is built
 * once; per-frame updates only rewrite the matrix. (The previous
 * ground-clamped ellipse entity got new ConstantProperty values every frame,
 * which re-tessellated a classification GroundPrimitive per frame.)
 */

import * as Cesium from 'cesium';

export interface ShadowHandle {
  primitive: Cesium.Primitive;
  destroy(): void;
}

/** Disc thickness (m) and lift above the rider's ground (m, avoids z-fighting). */
const DISC_HALF_THICKNESS_M = 0.01;
const DISC_LIFT_M = 0.06;
const BASE_MINOR_M = 0.55;
/** Longest shadow half-length (m): a 1.7 m rider at ~15° sun. */
const MAX_SEMI_MAJOR_M = 3.2;

/**
 * Create the shadow primitive (hidden until the first update).
 * Returns a handle so the caller can update and destroy it.
 */
export function createShadowEntity(viewer: Cesium.Viewer): ShadowHandle {
  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.EllipsoidGeometry({
        radii: new Cesium.Cartesian3(1, 1, 1),
        stackPartitions: 4,
        slicePartitions: 32,
        vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
      }),
      id: 'rider-ground-shadow',
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromAlpha(Cesium.Color.BLACK, 0.32)),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
    modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    asynchronous: false,
    allowPicking: false,
    shadows: Cesium.ShadowMode.DISABLED,
    show: false,
  });
  viewer.scene.primitives.add(primitive);
  return {
    primitive,
    destroy() {
      if (!viewer.isDestroyed() && !primitive.isDestroyed()) viewer.scene.primitives.remove(primitive);
    },
  };
}

/** Rider position passed to updateShadowEntity each frame. */
export interface RiderPos {
  lat: number;
  lon: number;
  ele: number;
  /** Road gradient, % (tilts the disc onto the slope). */
  grade?: number;
  /** Rider heading, radians clockwise from north (direction of `grade`). */
  heading?: number;
}

export interface ShadowShape {
  /** Half-length along the shadow direction, m. */
  semiMajor: number;
  /** Half-width across it, m. */
  semiMinor: number;
  /** Direction the shadow points TO, radians clockwise from north. */
  bearing: number;
  /** Distance from the rider to the disc centre along `bearing`, m. */
  offset: number;
}

/**
 * Pure shadow footprint for a sun position: null at night. The disc starts
 * under the rider and stretches away from the sun as it sinks
 * (cot(altitude), clamped).
 */
export function shadowShape(sunAzimuthDeg: number, sunAltitudeDeg: number): ShadowShape | null {
  if (!(sunAltitudeDeg > 0) || !Number.isFinite(sunAzimuthDeg)) return null;
  const alt = (Math.max(5, Math.min(sunAltitudeDeg, 85)) * Math.PI) / 180;
  const stretch = 1 / Math.tan(alt);
  const semiMajor = Math.min(MAX_SEMI_MAJOR_M, BASE_MINOR_M * (1 + stretch));
  return {
    semiMajor,
    semiMinor: BASE_MINOR_M,
    bearing: (((sunAzimuthDeg + 180) % 360) * Math.PI) / 180,
    offset: Math.max(0, semiMajor - BASE_MINOR_M),
  };
}

const scratchEnu = new Cesium.Matrix4();
const scratchLocal = new Cesium.Matrix4();
const scratchOrigin = new Cesium.Cartesian3();
const scratchCols: number[] = new Array<number>(16).fill(0);

/**
 * Write the disc's local transform (ENU metres) for a shape into `result`:
 * columns = major axis × semiMajor, minor axis × semiMinor, up × thickness;
 * translation = centre offset along the bearing, lifted off the ground.
 * With a slope (grade along heading) the disc is sheared onto the road plane
 * z = g·(x·sin h + y·cos h), so a long evening shadow doesn't sink into a
 * climb or float over a descent.
 */
export function shadowLocalMatrix(
  shape: ShadowShape,
  result: Cesium.Matrix4,
  slope?: { grade: number; heading: number },
): Cesium.Matrix4 {
  const sx = Math.sin(shape.bearing);
  const cy = Math.cos(shape.bearing);
  // Column-major: major axis in ENU (x = east, y = north), minor axis 90° to
  // it, squashed up axis, then the centre offset.
  const m = scratchCols;
  m[0] = sx * shape.semiMajor;  m[1] = cy * shape.semiMajor;  m[2] = 0;  m[3] = 0;
  m[4] = -cy * shape.semiMinor; m[5] = sx * shape.semiMinor;  m[6] = 0;  m[7] = 0;
  m[8] = 0;                     m[9] = 0;                     m[10] = DISC_HALF_THICKNESS_M; m[11] = 0;
  m[12] = sx * shape.offset;    m[13] = cy * shape.offset;    m[14] = DISC_LIFT_M; m[15] = 1;
  if (slope && Number.isFinite(slope.grade) && Number.isFinite(slope.heading) && slope.grade !== 0) {
    const g = Math.max(-0.3, Math.min(0.3, slope.grade / 100));
    const sh = Math.sin(slope.heading);
    const ch = Math.cos(slope.heading);
    m[2] = g * (m[0] * sh + m[1] * ch);
    m[6] = g * (m[4] * sh + m[5] * ch);
    m[14] += g * (m[12] * sh + m[13] * ch);
  }
  return Cesium.Matrix4.unpack(m, 0, result);
}

/**
 * Move/resize the shadow for the current sun angle and rider position.
 *
 * @param sunAzimuth   Sun azimuth in degrees (CW from North).
 * @param sunAltitude  Sun altitude in degrees above horizon.
 */
export function updateShadowEntity(
  handle: ShadowHandle,
  riderPos: RiderPos,
  sunAzimuth: number,
  sunAltitude: number,
): void {
  const primitive = handle.primitive;
  if (!primitive || primitive.isDestroyed()) return;
  const shape = shadowShape(sunAzimuth, sunAltitude);
  if (!shape || !Number.isFinite(riderPos.lon) || !Number.isFinite(riderPos.lat) || !Number.isFinite(riderPos.ele)) {
    primitive.show = false;
    return;
  }
  primitive.show = true;
  Cesium.Cartesian3.fromDegrees(riderPos.lon, riderPos.lat, riderPos.ele, Cesium.Ellipsoid.WGS84, scratchOrigin);
  Cesium.Transforms.eastNorthUpToFixedFrame(scratchOrigin, Cesium.Ellipsoid.WGS84, scratchEnu);
  const slope =
    riderPos.grade !== undefined && riderPos.heading !== undefined
      ? { grade: riderPos.grade, heading: riderPos.heading }
      : undefined;
  Cesium.Matrix4.multiply(scratchEnu, shadowLocalMatrix(shape, scratchLocal, slope), primitive.modelMatrix);
}
