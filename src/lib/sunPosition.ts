/**
 * NOAA solar position (pure math, no engine imports) — shared by the Cesium
 * sky (lib/skyAndClouds) and the three.js world renderer.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Result of the solar-position calculation. */
export interface SolarPosition {
  /** Sun azimuth in degrees, measured clockwise from North (0–360). */
  azimuth: number;
  /** Sun altitude (elevation) in degrees above the horizon (−90 to +90). */
  altitude: number;
}

/**
 * Compute solar azimuth and altitude for a given wall-clock time and position.
 *
 * Uses the NOAA Solar Position algorithm based on the work of Meeus (1998) and
 * Spencer (1971). Accurate to within ~0.01° for dates 2000–2050.
 *
 * Reference: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 *
 * @param now   Wall-clock Date to evaluate (typically `new Date()`).
 * @param lat   Observer latitude in degrees, positive = N.
 * @param lon   Observer longitude in degrees, positive = E.
 * @returns     { azimuth (°, CW from N), altitude (°) }
 */
export function sunAzimuthAndAltitude(
  now: Date,
  lat: number,
  lon: number,
): SolarPosition {
  // ---- Julian Day Number ----
  const julianDay = now.getTime() / 86_400_000 + 2_440_587.5;

  // ---- Julian Century ----
  const jc = (julianDay - 2_451_545.0) / 36_525.0;

  // ---- Geometric mean longitude of the sun (degrees) ----
  const geoMeanLon = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;

  // ---- Geometric mean anomaly of the sun (degrees) ----
  const geoMeanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);

  // ---- Eccentricity of Earth's orbit ----
  const eccOrbit = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);

  // ---- Equation of Center ----
  const anomRad = geoMeanAnom * DEG;
  const eqCtr =
    Math.sin(anomRad) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * anomRad) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * anomRad) * 0.000289;

  // ---- Sun's true longitude ----
  const sunTrueLon = geoMeanLon + eqCtr;

  // ---- Sun's apparent longitude ----
  const omega = 125.04 - 1934.136 * jc;
  const sunAppLon = sunTrueLon - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // ---- Mean obliquity of ecliptic ----
  const meanObliq =
    23.0 +
    (26.0 + (21.448 - jc * (46.8150 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0;

  // ---- Corrected obliquity ----
  const corrObliq = meanObliq + 0.00256 * Math.cos(omega * DEG);

  // ---- Sun declination ----
  const sunDecl = Math.asin(Math.sin(corrObliq * DEG) * Math.sin(sunAppLon * DEG)) * RAD;

  // ---- Equation of Time (minutes) ----
  const y = Math.tan((corrObliq / 2) * DEG) ** 2;
  const eqTime =
    4 *
    RAD *
    (y * Math.sin(2 * geoMeanLon * DEG) -
      2 * eccOrbit * Math.sin(geoMeanAnom * DEG) +
      4 * eccOrbit * y * Math.sin(geoMeanAnom * DEG) * Math.cos(2 * geoMeanLon * DEG) -
      0.5 * y * y * Math.sin(4 * geoMeanLon * DEG) -
      1.25 * eccOrbit * eccOrbit * Math.sin(2 * geoMeanAnom * DEG));

  // ---- True solar time (minutes) ----
  const utcMinutes =
    now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  const trueSolarTime = ((utcMinutes + eqTime + 4 * lon) % 1440 + 1440) % 1440;

  // ---- Hour angle (degrees) ----
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  // ---- Solar zenith angle ----
  const latRad = lat * DEG;
  const declRad = sunDecl * DEG;
  const haRad = hourAngle * DEG;

  const cosZenith =
    Math.sin(latRad) * Math.sin(declRad) +
    Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad);
  const zenithDeg = Math.acos(Math.max(-1, Math.min(1, cosZenith))) * RAD;
  const altitudeDeg = 90.0 - zenithDeg;

  // ---- Atmospheric refraction correction ----
  let refractionCorr = 0;
  if (altitudeDeg > 85) {
    refractionCorr = 0;
  } else if (altitudeDeg > 5) {
    refractionCorr =
      (58.1 / Math.tan(altitudeDeg * DEG) -
        0.07 / Math.tan(altitudeDeg * DEG) ** 3 +
        0.000086 / Math.tan(altitudeDeg * DEG) ** 5) /
      3600;
  } else if (altitudeDeg > -0.575) {
    refractionCorr =
      (1735 +
        altitudeDeg *
          (-518.2 + altitudeDeg * (103.4 + altitudeDeg * (-12.79 + altitudeDeg * 0.711)))) /
      3600;
  } else {
    refractionCorr = -20.774 / (3600 * Math.tan(altitudeDeg * DEG));
  }
  const correctedAlt = altitudeDeg + refractionCorr;

  // ---- Solar azimuth (clockwise from North) ----
  let azimuthDeg: number;
  if (hourAngle > 0) {
    azimuthDeg =
      (Math.acos(
        Math.max(
          -1,
          Math.min(
            1,
            (Math.sin(latRad) * cosZenith - Math.sin(declRad)) /
              (Math.cos(latRad) * Math.sin(zenithDeg * DEG)),
          ),
        ),
      ) *
        RAD +
        180) %
      360;
  } else {
    azimuthDeg =
      (540 -
        Math.acos(
          Math.max(
            -1,
            Math.min(
              1,
              (Math.sin(latRad) * cosZenith - Math.sin(declRad)) /
                (Math.cos(latRad) * Math.sin(zenithDeg * DEG)),
            ),
          ),
        ) *
          RAD) %
      360;
  }

  return { azimuth: azimuthDeg, altitude: correctedAlt };
}
