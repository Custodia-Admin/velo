/**
 * Easy & Scenic — flat or gently rolling rides with a big visual payoff.
 *
 * The comfort-first counterpart to the iconic climbs. Geometry is real road
 * and path data (see scripts/build-scenic-routes.mjs); each route carries a
 * cinematic mood that CesiumViewer applies at ride start, the same way the
 * iconic catalogue does.
 */

import type { Route, RoutePoint } from '@/types';
import type { MoodId } from '@/lib/cesiumUtils';
import { haversine } from '@/lib/utils';
import { SCENIC_ROUTE_GEOMETRY, type ScenicRouteGeometry } from '@/lib/scenicRouteData';
import { destinationForRoute, type DestinationRole } from '@/lib/world/destinations';

export type Scenery = 'lake' | 'coast' | 'valley' | 'alpine-lake' | 'river';
export type ScenicCharacter = 'flat' | 'gentle';

export interface ScenicRouteInfo {
  route: Route;
  /** Display name, e.g. "Lugano lakefront to Melide". */
  name: string;
  /** Short place line, e.g. "Ticino · Lake Lugano". */
  place: string;
  /** One sentence on what you'll see. */
  description: string;
  scenery: Scenery;
  /** Derived from the profile: flat, or gentle (a slow rise or small rollers). */
  character: ScenicCharacter;
  /** Steepest ~200 m stretch of the real road, percent. */
  maxGradePct: number;
  /** Rough ride time at an easy pace, minutes (rounded to 5). */
  estMinutes: number;
  mood: MoodId;
}

interface ScenicMeta {
  id: string;
  name: string;
  place: string;
  description: string;
  scenery: Scenery;
  mood: MoodId;
}

/**
 * Library order. Today's ride rotates through the home routes in this order
 * and the setup wizard lists routes in it; Home's sections follow the
 * destination manifests (src/lib/world/destinations/*.json), which also say
 * where each route sits for the household (`role`: home, hometown, wishlist).
 */
const SCENIC_META: ScenicMeta[] = [
  // ── Perugia ──
  {
    id: 'scenic-trasimeno-shore',
    name: 'Lake Trasimeno shore',
    place: 'Umbria · Lago Trasimeno',
    description:
      'Castiglione del Lago to Passignano on the lakeside cycle path.',
    scenery: 'lake',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-perugia-tiber-park',
    name: 'Tiber river park',
    place: 'Perugia · Tiber valley',
    description:
      'Ponte San Giovanni to Ponte Felcino, below the hill of Perugia.',
    scenery: 'river',
    mood: 'clear-afternoon',
  },
  {
    id: 'scenic-assisi-valley',
    name: 'Assisi valley floor',
    place: 'Umbria · Valle Umbra',
    description:
      'A loop on the valley floor below Assisi: Santa Maria degli Angeli, Rivotorto and Bastia, out and home on different roads.',
    scenery: 'valley',
    mood: 'clear-noon',
  },
  // ── Ticino and the Lombardy lakes ──
  {
    id: 'scenic-lugano-melide',
    name: 'Lugano lakefront to Melide',
    place: 'Ticino · Lake Lugano',
    description:
      "Lugano's lakefront promenade, Paradiso, then the shore road to Melide and out over the causeway with water on both sides.",
    scenery: 'lake',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-locarno-brissago',
    name: 'Locarno to Brissago',
    place: 'Ticino · Lago Maggiore',
    description:
      "From Locarno over Ascona's Collinetta and along the shore road toward Brissago, with the Brissago Islands just offshore.",
    scenery: 'lake',
    mood: 'clear-afternoon',
  },
  {
    id: 'scenic-valle-maggia',
    name: 'Valle Maggia',
    place: 'Ticino · Alpine valley',
    description:
      'Up the Maggia river from Ponte Brolla through stone villages to Cevio, granite walls and waterfalls on both sides.',
    scenery: 'valley',
    mood: 'clear-noon',
  },
  {
    id: 'scenic-magadino-plain',
    name: 'Bellinzona to Locarno',
    place: 'Ticino · Magadino plain',
    description:
      'From the castle town of Bellinzona across the flat Magadino plain to the head of Lago Maggiore.',
    scenery: 'valley',
    mood: 'clear-afternoon',
  },
  {
    id: 'scenic-lake-varese',
    name: 'Lake Varese shore',
    place: 'Lombardy · Lago di Varese',
    description:
      'The lakeside cycle path from Gavirate round the south shore to Schiranna, Monte Rosa on the skyline on a clear day.',
    scenery: 'lake',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-lake-como-menaggio',
    name: 'Menaggio to Gravedona',
    place: 'Lombardy · Lake Como',
    description:
      "Along Lake Como's western shore through Dongo to Gravedona, mountains dropping straight into the water.",
    scenery: 'lake',
    mood: 'mediterranean-mist',
  },
  // ── Alpine lakes, Garda and the Riviera ──
  {
    id: 'scenic-engadin-lakes',
    name: 'Engadin lakes',
    place: 'Graubünden · Upper Engadine',
    description:
      'Maloja to St. Moritz past the Sils and Silvaplana lakes at 1800 m, larch forest below and glaciers above.',
    scenery: 'alpine-lake',
    mood: 'clear-noon',
  },
  {
    id: 'scenic-lavaux-chillon',
    name: 'Lausanne to Chillon',
    place: 'Vaud · Lake Geneva',
    description:
      'Below the Lavaux vineyard terraces through Vevey and Montreux to Chillon Castle, the Alps across the lake.',
    scenery: 'lake',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-riviera-dei-fiori',
    name: 'Riviera dei Fiori',
    place: 'Liguria · Mediterranean coast',
    description:
      'An old seaside railway turned cycle path, Ospedaletti through Sanremo to San Lorenzo al Mare, the sea beside you all the way.',
    scenery: 'coast',
    mood: 'mediterranean-mist',
  },
  {
    id: 'scenic-lake-annecy',
    name: 'Lake Annecy',
    place: 'Haute-Savoie · Lac d’Annecy',
    description:
      'The greenway along the west shore from Annecy to the end of the lake, turquoise water under the mountains.',
    scenery: 'lake',
    mood: 'clear-afternoon',
  },
  {
    id: 'scenic-lake-garda-lazise',
    name: 'Peschiera to Lazise',
    place: 'Veneto · Lake Garda',
    description:
      "The lakeside cycle path from Peschiera del Garda's harbour north along the east shore to Lazise.",
    scenery: 'lake',
    mood: 'golden-hour',
  },
  // ── China, the United States and Mexico ──
  {
    id: 'scenic-chengdu-luxe-lakes',
    name: 'Luxe Lakes loop',
    place: 'Chengdu · Tianfu New Area',
    description: 'A loop on the roads and paths around the Luxe Lakes (Luhu), south of central Chengdu.',
    scenery: 'lake',
    mood: 'mediterranean-mist',
  },
  {
    id: 'scenic-chengdu-xinglong-lake',
    name: 'Xinglong Lake loop',
    place: 'Chengdu · Tianfu New Area',
    description:
      'Clockwise round Xinglong Lake on the lakeside road and its bike lanes, the signed local cycle loop, with the water on your right.',
    scenery: 'lake',
    mood: 'mediterranean-mist',
  },
  {
    id: 'scenic-hangzhou-west-lake',
    name: 'West Lake loop',
    place: 'Hangzhou · West Lake',
    description:
      'Round West Lake from the Broken Bridge along the north shore, the Yanggong causeway and Nanshan Road past Leifeng Pagoda.',
    scenery: 'lake',
    mood: 'mediterranean-mist',
  },
  {
    id: 'scenic-cuyahoga-towpath',
    name: 'Ohio & Erie Canal Towpath',
    place: 'Ohio · Cuyahoga Valley',
    description:
      'The crushed-stone canal towpath through Cuyahoga Valley National Park from Station Road Bridge past Boston and Peninsula to Beaver Marsh.',
    scenery: 'river',
    mood: 'clear-afternoon',
  },
  {
    id: 'scenic-cuyahoga-towpath-north',
    name: 'Towpath: Lock 39 to Station Road',
    place: 'Ohio · Cuyahoga Valley',
    description:
      'The towpath’s northern miles, from Lock 39 at Rockside Road south along the canal past the Canal Exploration Center to Station Road Bridge in Brecksville.',
    scenery: 'river',
    mood: 'clear-afternoon',
  },
  {
    id: 'scenic-cleveland-lakefront',
    name: 'Cleveland lakefront',
    place: 'Ohio · Lake Erie',
    description:
      'The Lakefront Bikeway from Edgewater Park past downtown and the harbour to Gordon Park at East 72nd Street.',
    scenery: 'lake',
    mood: 'dusk-cool',
  },
  {
    id: 'scenic-wendy-park-lakewood',
    name: 'Wendy Park to Lakewood Park',
    place: 'Ohio · Lake Erie',
    description:
      'From Wendy Park at the river mouth across Whiskey Island and past Edgewater Park’s beach, then along the lakeside streets of Edgewater and Lakewood’s Gold Coast to Lakewood Park.',
    scenery: 'lake',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-berkeley-bay-trail',
    name: 'Berkeley shoreline',
    place: 'California · San Francisco Bay',
    description:
      'The Bay Trail from Point Isabel past Albany, César Chávez Park and the Berkeley Marina to the Emeryville shore.',
    scenery: 'coast',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-richmond-marina-bay',
    name: 'Richmond Marina Bay',
    place: 'California · San Francisco Bay',
    description:
      'The Bay Trail north from the Albany waterfront past Point Isabel and the Meeker Slough marsh, round Marina Bay to Ford Point.',
    scenery: 'coast',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-santa-monica-strand',
    name: 'Santa Monica to Hermosa Beach',
    place: 'California · Pacific coast',
    description:
      'The beach bike path from Santa Monica Pier past Venice, round Marina del Rey and down The Strand to Hermosa Beach Pier.',
    scenery: 'coast',
    mood: 'clear-afternoon',
  },
  {
    id: 'scenic-will-rogers-venice',
    name: 'Will Rogers to Venice',
    place: 'California · Santa Monica Bay',
    description:
      'The beach bike path from Will Rogers State Beach under the Palisades bluffs, past Santa Monica Pier to Venice Beach.',
    scenery: 'coast',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-puerto-vallarta-malecon',
    name: 'Puerto Vallarta bayfront',
    place: 'Jalisco · Banderas Bay',
    description:
      'Along the malecón from the Zona Romántica, over the Cuale and past the old town seafront, then up the hotel-zone boulevard to Marina Vallarta.',
    scenery: 'coast',
    mood: 'golden-hour',
  },
  {
    id: 'scenic-nuevo-vallarta-bucerias',
    name: 'Nuevo Vallarta to Bucerías',
    place: 'Nayarit · Banderas Bay',
    description:
      'Along the palm-lined Paseo de los Cocoteros past the Nuevo Vallarta beach resorts to the fishing town of Bucerías and its beachfront street.',
    scenery: 'coast',
    mood: 'golden-hour',
  },
];

/** Longest segment we ship to the ride loop, metres. Keeps the chase cam smooth. */
const MAX_SEGMENT_M = 50;

/** Build a Route from generated [lat, lon, ele] geometry, densified to ≤50 m. */
export function routeFromGeometry(id: string, name: string, geom: ScenicRouteGeometry): Route {
  const src = geom.points;
  const points: RoutePoint[] = [];
  let dist = 0;
  let ascent = 0;
  let descent = 0;
  let minEle = Infinity;
  let maxEle = -Infinity;

  const push = (lat: number, lon: number, ele: number) => {
    const prev = points[points.length - 1];
    if (prev) {
      const d = haversine(prev.lat, prev.lon, lat, lon);
      if (d < 0.01) return;
      dist += d;
      const dEle = ele - prev.ele;
      if (dEle > 0) ascent += dEle;
      else descent -= dEle;
    }
    points.push({ lat, lon, ele, distance: dist });
    if (ele < minEle) minEle = ele;
    if (ele > maxEle) maxEle = ele;
  };

  for (let i = 0; i < src.length; i++) {
    const [lat, lon, ele] = src[i];
    if (i > 0) {
      const [lat0, lon0, ele0] = src[i - 1];
      const seg = haversine(lat0, lon0, lat, lon);
      const steps = Math.ceil(seg / MAX_SEGMENT_M);
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        push(lat0 + (lat - lat0) * f, lon0 + (lon - lon0) * f, ele0 + (ele - ele0) * f);
      }
    }
    push(lat, lon, ele);
  }

  return {
    id,
    name,
    points,
    totalDistance: dist,
    ascent,
    descent,
    minElevation: minEle,
    maxElevation: maxEle,
    loadedAt: Date.now(),
  };
}

/** Flat if it barely climbs and never pitches up; otherwise gentle. */
export function characterFor(distanceM: number, ascentM: number, maxGradePct: number): ScenicCharacter {
  const ascentPerKm = ascentM / Math.max(distanceM / 1000, 1);
  return ascentPerKm < 6 && maxGradePct <= 4 ? 'flat' : 'gentle';
}

/** Easy-pace ride time: ~20 km/h flat, ~17 km/h gentle, rounded to 5 min. */
export function estimateEasyMinutes(distanceM: number, character: ScenicCharacter): number {
  const kmh = character === 'flat' ? 20 : 17;
  return Math.max(5, Math.round(((distanceM / 1000 / kmh) * 60) / 5) * 5);
}

function build(meta: ScenicMeta): ScenicRouteInfo {
  const geom = SCENIC_ROUTE_GEOMETRY[meta.id];
  if (!geom) throw new Error(`scenic route geometry missing: ${meta.id}`);
  const route = routeFromGeometry(meta.id, meta.name, geom);
  const character = characterFor(route.totalDistance, route.ascent, geom.maxGradePct);
  return {
    ...meta,
    route,
    character,
    maxGradePct: geom.maxGradePct,
    estMinutes: estimateEasyMinutes(route.totalDistance, character),
  };
}

/** The full Easy & Scenic collection. Built once, module-level. */
export const SCENIC_ROUTES: ScenicRouteInfo[] = SCENIC_META.map(build);

export function scenicRouteById(id: string): ScenicRouteInfo | undefined {
  return SCENIC_ROUTES.find((r) => r.route.id === id);
}

/** Where a route sits for the household: its destination manifest's role. */
export function scenicRole(routeId: string): DestinationRole | null {
  return destinationForRoute(routeId)?.role ?? null;
}

/** The routes whose destination has this role, in library order. */
export function scenicRoutesWithRole(role: DestinationRole): ScenicRouteInfo[] {
  return SCENIC_ROUTES.filter((r) => scenicRole(r.route.id) === role);
}

/** Closest first: the home routes, then the hometown ones. */
export function homeFirstScenicRoutes(): ScenicRouteInfo[] {
  return [...scenicRoutesWithRole('home'), ...scenicRoutesWithRole('hometown')];
}

/**
 * "Today's ride": a home route that changes once a day, the same for both
 * riders so they can share a pick.
 */
export function todaysScenicRoute(now: Date = new Date()): ScenicRouteInfo {
  const near = scenicRoutesWithRole('home');
  const pool = near.length > 0 ? near : SCENIC_ROUTES;
  const dayIndex = Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000,
  );
  return pool[dayIndex % pool.length];
}

/** Random pick for "just start" flows: a home route. */
export function randomScenicRoute(rand: () => number = Math.random): ScenicRouteInfo {
  const near = scenicRoutesWithRole('home');
  return near[Math.floor(rand() * near.length) % near.length];
}
