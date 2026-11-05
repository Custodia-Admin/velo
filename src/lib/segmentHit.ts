/**
 * segmentHit.ts: where a straight segment first runs into a triangle mesh.
 *
 * The side camera's sight (lib/sideCamSight) asks whether the line from the
 * rider's bars to a camera spot is open. Cesium3DTileset.pick answers that
 * for an endless ray and only in the tile whose bounding sphere is nearest
 * the ray's origin, and its pickModel moves every vertex of a tile into world
 * space before testing it: about 2 ms a ray on cat-bed's iGPU, the same as a
 * height read. Here the segment is moved into the tile's own frame once
 * instead, and a triangle whose corners all lie on one side of the segment's
 * box is dropped before any cross product: about 0.1 ms a ray over the same
 * tiles, with the same hits (783 of 783 on the Lugano shore, t_ee2165b8).
 *
 * Like pickModel, triangles facing away from the segment's start are not
 * hits (backface culling): seen from the road, the walls, hedges, banks and
 * crowns facing it are hit, a canopy's underside above the line is not.
 *
 * Pure and engine-free: positions and indices are plain arrays.
 */

/** No hit on the segment. */
export const NO_HIT = Number.POSITIVE_INFINITY;

/**
 * The first triangle the segment a -> b crosses, as a fraction of the way
 * from a to b (0..1); {@link NO_HIT} when it crosses none.
 *
 * `positions` holds `stride` numbers per vertex (x, y, z first) in the same
 * frame as a and b; `indices` three vertex indices per triangle. With `cull`
 * (Cesium's default), only triangles wound counter-clockwise as seen from a
 * count; `flip` turns that round (a frame with a mirroring transform).
 */
export function segmentTriangleHit(
  positions: ArrayLike<number>,
  stride: number,
  indices: ArrayLike<number>,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cull = true,
  flip = false,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);
  const minZ = Math.min(az, bz);
  const maxZ = Math.max(az, bz);
  const sign = flip ? -1 : 1;
  let best = NO_HIT;
  const n = indices.length - (indices.length % 3);
  for (let i = 0; i < n; i += 3) {
    const p = indices[i] * stride;
    const q = indices[i + 1] * stride;
    const r = indices[i + 2] * stride;
    const px = positions[p];
    const qx = positions[q];
    const rx = positions[r];
    if ((px < minX && qx < minX && rx < minX) || (px > maxX && qx > maxX && rx > maxX)) continue;
    const py = positions[p + 1];
    const qy = positions[q + 1];
    const ry = positions[r + 1];
    if ((py < minY && qy < minY && ry < minY) || (py > maxY && qy > maxY && ry > maxY)) continue;
    const pz = positions[p + 2];
    const qz = positions[q + 2];
    const rz = positions[r + 2];
    if ((pz < minZ && qz < minZ && rz < minZ) || (pz > maxZ && qz > maxZ && rz > maxZ)) continue;
    // Moller-Trumbore, as Cesium's IntersectionTests.rayTriangleParametric.
    const e1x = qx - px;
    const e1y = qy - py;
    const e1z = qz - pz;
    const e2x = rx - px;
    const e2y = ry - py;
    const e2z = rz - pz;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    // Facing away from a (or edge-on): not a hit when culling.
    if (cull ? !(det * sign > 0) : !(det !== 0 && Number.isFinite(det))) continue;
    const inv = 1 / det;
    const tx = ax - px;
    const ty = ay - py;
    const tz = az - pz;
    const u = (tx * hx + ty * hy + tz * hz) * inv;
    if (u < 0 || u > 1) continue;
    const kx = ty * e1z - tz * e1y;
    const ky = tz * e1x - tx * e1z;
    const kz = tx * e1y - ty * e1x;
    const v = (dx * kx + dy * ky + dz * kz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * kx + e2y * ky + e2z * kz) * inv;
    if (t >= 0 && t <= 1 && t < best) best = t;
  }
  return best;
}

/** Does the segment a -> b pass within `radius` of the centre c? */
export function segmentMeetsSphere(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let k = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / len2 : 0;
  k = Math.max(0, Math.min(1, k));
  const ex = ax + k * dx - cx;
  const ey = ay + k * dy - cy;
  const ez = az + k * dz - cz;
  return ex * ex + ey * ey + ez * ez <= radius * radius;
}
