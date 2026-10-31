/**
 * Geographic ↔ world-metre projection for baked worlds.
 *
 * Every world uses a local transverse Mercator (WGS84 ellipsoid, scale 1 on
 * the central meridian) centred on the world's origin: x grows east, y grows
 * north, (0, 0) is the origin. Over a 30 km world the scale error is below
 * 6 ppm, so world metres are real metres for physics and rendering.
 *
 * Krüger series to fourth order in n (Karney 2011); round-trip error is
 * sub-millimetre anywhere within a few hundred km of the origin.
 *
 * This file is shared with the bake (tools/worldbake imports it through Node's
 * TypeScript type stripping), so it must stay dependency-free and use only
 * erasable TypeScript syntax.
 */

export interface ProjectionParams {
  type: 'tmerc';
  ellipsoid: 'WGS84';
  /** Origin latitude, degrees. World y = 0 here. */
  lat0: number;
  /** Central meridian, degrees. World x = 0 here. */
  lon0: number;
  /** Scale factor on the central meridian. */
  k0: number;
}

export interface WorldProjection {
  readonly params: ProjectionParams;
  /** Degrees → world metres [x east, y north]. */
  forward(lat: number, lon: number): [number, number];
  /** World metres → degrees [lat, lon]. */
  inverse(x: number, y: number): [number, number];
}

const A_WGS84 = 6378137;
const F_WGS84 = 1 / 298.257223563;
const DEG = Math.PI / 180;

export function createProjection(params: ProjectionParams): WorldProjection {
  if (params.type !== 'tmerc' || params.ellipsoid !== 'WGS84') {
    throw new Error(`unsupported projection ${params.type}/${params.ellipsoid}`);
  }
  const n = F_WGS84 / (2 - F_WGS84);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n3 * n;
  const rectA = (A_WGS84 / (1 + n)) * (1 + n2 / 4 + n4 / 64);
  const alpha = [
    n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180,
    (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440,
    (61 * n3) / 240 - (103 * n4) / 140,
    (49561 * n4) / 161280,
  ];
  const beta = [
    n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360,
    n2 / 48 + n3 / 15 - (437 * n4) / 1440,
    (17 * n3) / 480 - (37 * n4) / 840,
    (4397 * n4) / 161280,
  ];
  const delta = [
    2 * n - (2 * n2) / 3 - 2 * n3 + (116 * n4) / 45,
    (7 * n2) / 3 - (8 * n3) / 5 - (227 * n4) / 45,
    (56 * n3) / 15 - (136 * n4) / 35,
    (4279 * n4) / 630,
  ];
  const e2n = (2 * Math.sqrt(n)) / (1 + n);
  const kA = params.k0 * rectA;
  const lon0 = params.lon0 * DEG;

  /** Conformal (ξ, η) on the ellipsoid → series-corrected (ξ, η). */
  const xiEta = (lat: number, dLon: number): [number, number] => {
    const sinPhi = Math.sin(lat);
    const t = Math.sinh(Math.atanh(sinPhi) - e2n * Math.atanh(e2n * sinPhi));
    const xiP = Math.atan2(t, Math.cos(dLon));
    const etaP = Math.atanh(Math.sin(dLon) / Math.sqrt(1 + t * t));
    let xi = xiP;
    let eta = etaP;
    for (let j = 1; j <= 4; j++) {
      xi += alpha[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
      eta += alpha[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    }
    return [xi, eta];
  };

  const xi0 = xiEta(params.lat0 * DEG, 0)[0];

  return {
    params: { ...params },
    forward(lat, lon) {
      const [xi, eta] = xiEta(lat * DEG, lon * DEG - lon0);
      return [kA * eta, kA * (xi - xi0)];
    },
    inverse(x, y) {
      const xi = y / kA + xi0;
      const eta = x / kA;
      let xiP = xi;
      let etaP = eta;
      for (let j = 1; j <= 4; j++) {
        xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
        etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
      }
      const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
      let phi = chi;
      for (let j = 1; j <= 4; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
      const lam = lon0 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
      return [phi / DEG, lam / DEG];
    },
  };
}
