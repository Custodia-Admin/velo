/**
 * Photographic plates ("posters") for routes inside a baked world.
 *
 * Velo v2 leads each ride with a still of its world (docs/design/v2-identity.md
 * §6). The stills are rendered offline from the world bundle by
 * scripts/v2-world-thumbs and ship as static files under public/posters/<world>/
 * (outside the world bundle, whose directory must match its manifest). Routes
 * without a poster get a map plate (the real route on a 1 km graticule).
 *
 * Engine-free (src/lib/world rule): no Cesium, three.js or React.
 */

export interface RoutePosters {
  /** Landscape still (Home hero / tile). */
  plate: string;
  /** Blue-hour variant of `plate` for the night theme, when one exists. */
  plateNight?: string;
  /** Wide still of where the ride ends (finish screen). */
  finish: string;
  /** Portrait crop of `finish` for phones. */
  finishPortrait?: string;
  /** What the plate shows, for screen readers. */
  alt: string;
}

interface PosterEntry {
  world: string;
  plate: string;
  plateNight?: string;
  finish?: string;
  finishPortrait?: string;
  alt: string;
}

const POSTERS: Record<string, PosterEntry> = {
  'scenic-perugia-tiber-park': {
    world: 'perugia',
    plate: 'home-hero-tiber.jpg',
    plateNight: 'home-hero-tiber-night.jpg',
    finish: 'finish-arrival.jpg',
    finishPortrait: 'finish-arrival-portrait.jpg',
    alt: 'The Tiber river path below Perugia at golden hour',
  },
  'scenic-assisi-valley': {
    world: 'perugia',
    plate: 'home-assisi.jpg',
    alt: 'The Assisi valley floor in late afternoon light',
  },
};

function postersBaseUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const base = env.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}posters/`;
}

/** Poster URLs for a route, or null when it has none (use a map plate). */
export function postersFor(routeId: string | null | undefined): RoutePosters | null {
  const e = routeId ? POSTERS[routeId] : undefined;
  if (!e) return null;
  const dir = `${postersBaseUrl()}${e.world}/`;
  return {
    plate: dir + e.plate,
    plateNight: e.plateNight ? dir + e.plateNight : undefined,
    finish: dir + (e.finish ?? e.plate),
    finishPortrait: e.finishPortrait ? dir + e.finishPortrait : undefined,
    alt: e.alt,
  };
}

/** Route ids that have posters (tests keep these in step with public/posters). */
export function routesWithPosters(): Array<{ routeId: string; files: string[] }> {
  return Object.entries(POSTERS).map(([routeId, e]) => ({
    routeId,
    files: [e.plate, e.plateNight, e.finish, e.finishPortrait]
      .filter((f): f is string => !!f)
      .map((f) => `${e.world}/${f}`),
  }));
}
