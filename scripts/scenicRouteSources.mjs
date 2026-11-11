/**
 * Where every "Easy & Scenic" route comes from: the waypoints the OSRM bike
 * router was asked to join, or the OSM bicycle route relation that was
 * chained instead. Read by scripts/build-scenic-routes.mjs (which builds
 * src/lib/scenicRouteData.ts from them) and by the world bake
 * (tools/worldbake/bake.mjs, recipe `routeCredits`), which credits each baked
 * route with the link that reproduces its geometry.
 *
 * Plain JS, no imports: [lat, lon] waypoints in riding order (loops repeat
 * the start at the end), or `relation: <OSM id>`.
 */

export const SCENIC_ROUTE_SOURCES = [
  // ── Near home: Perugia and Umbria ──
  {
    id: 'scenic-trasimeno-shore',
    // The signed shore path, Castiglione del Lago to Passignano. The bike
    // router prefers the SS71/SS75 alongside, so take the relation itself.
    relation: 1172330,
  },
  {
    id: 'scenic-perugia-tiber-park',
    // Ponte San Giovanni to Ponte Felcino on the Percorso Verde along the Tiber.
    waypoints: [[43.0900, 12.4400], [43.1336, 12.4421]],
  },
  {
    id: 'scenic-assisi-valley',
    // Valley floor only, one loop with no road ridden twice: Santa Maria degli
    // Angeli, the cycle path beside the SS75 to Rivotorto, back north-west on
    // Via Francesca along the foot of the hill (never up to Assisi), across
    // the Tescio plain on Via della Repubblica to Bastia, home on Via Roma.
    waypoints: [[43.0580, 12.5777], [43.0447, 12.6151], [43.0594, 12.6110], [43.0674, 12.5985], [43.0704, 12.5650], [43.0674, 12.5520], [43.0580, 12.5777]],
  },
  // ── Hometown: Ticino and the Lombardy lakes ──
  {
    id: 'scenic-lugano-melide',
    // Points on Riva Paradiso and the Via Cantonale, so the route stays on the
    // shore (no detour up to Paradiso station and back) and takes the Melide
    // roundabout straight onto the causeway.
    waypoints: [[46.0037, 8.9517], [45.98701, 8.95551], [45.96955, 8.94892], [45.9530, 8.9660]],
  },
  {
    id: 'scenic-locarno-brissago',
    // Through Ascona on Via Collinetta (the Via Moscia stretch at the tunnel
    // is bicycle=no), then the shore road. A waypoint off the shore snaps to
    // the "Ascona - Ronco" boat line and the route crosses the lake.
    waypoints: [[46.1670, 8.7980], [46.15036, 8.74413], [46.1190, 8.7120]],
  },
  {
    id: 'scenic-magadino-plain',
    waypoints: [[46.1920, 9.0170], [46.1650, 8.9500], [46.1700, 8.8800], [46.1780, 8.8500], [46.1670, 8.7980]],
  },
  {
    id: 'scenic-valle-maggia',
    waypoints: [[46.1880, 8.7540], [46.2480, 8.7080], [46.28605, 8.65821], [46.3160, 8.6030]],
  },
  {
    id: 'scenic-engadin-lakes',
    // Ends on the St. Moritz Bad lakeside path: the old end up in St. Moritz
    // Dorf took a switchback on Via Somplaz that reads as a U-turn.
    waypoints: [[46.4040, 9.6950], [46.4290, 9.7600], [46.4600, 9.7950], [46.48996, 9.83843]],
  },
  {
    id: 'scenic-lake-varese',
    // South-shore cycle path only; the north side climbs inland.
    waypoints: [[45.8440, 8.7160], [45.8170, 8.7080], [45.7930, 8.7300], [45.7900, 8.7600], [45.8080, 8.7980]],
  },
  {
    id: 'scenic-lake-como-menaggio',
    waypoints: [[46.0200, 9.2390], [46.0700, 9.2700], [46.12492, 9.28575], [46.1450, 9.3070]],
  },
  {
    id: 'scenic-lavaux-chillon',
    waypoints: [[46.5070, 6.6270], [46.5030, 6.6860], [46.4890, 6.7290], [46.4625, 6.8420], [46.4330, 6.9100], [46.4140, 6.9270]],
  },
  {
    id: 'scenic-riviera-dei-fiori',
    waypoints: [[43.8010, 7.7170], [43.8150, 7.7760], [43.83131, 7.85480], [43.8530, 7.9640]],
  },
  {
    id: 'scenic-lake-annecy',
    waypoints: [[45.8990, 6.1290], [45.8640, 6.1440], [45.8270, 6.2020], [45.7800, 6.2180]],
  },
  {
    id: 'scenic-lake-garda-lazise',
    // Points on the Peschiera–Lazise lakeside cycle path; past Lazise it turns inland.
    // Inland start, deliberately: since OSM changeset 191376414 (2 Nov 2026, a
    // survey edit) the 190 m of Passeggiata Giuseppe Garibaldi north of the
    // beach (way 1158666741) is a footway with bicycle=no, so the shore path
    // has no bike-legal link there. The router turns back at the beach (point 2;
    // the 1.6 km out-and-back is cut) and rides Via Marzan and Via Campanello,
    // rejoining the shore path 2.35 km in. Point 2 stays on the promenade so the
    // route returns to the shore by itself if bikes are allowed there again.
    waypoints: [[45.4390, 10.6920], [45.4470, 10.6957], [45.4563, 10.7007], [45.4645, 10.7114], [45.4734, 10.7158], [45.4821, 10.7216], [45.5017, 10.7321], [45.5052, 10.7330]],
  },
  // ── Travels: places on the wishlist ──
  {
    id: 'scenic-chengdu-luxe-lakes',
    waypoints: [[30.4720, 104.0600], [30.4580, 104.0700], [30.4445, 104.0600], [30.4580, 104.0495], [30.4720, 104.0600]],
  },
  {
    id: 'scenic-chengdu-xinglong-lake',
    // Round Xinglong Lake on the lakeside road (Hupan Lu) and its bike lanes,
    // clockwise with the lake on the right: the signed local cycle route,
    // OSM relation 18146670 "环兴隆湖（顺时针）" (Around Xinglong Lake, clockwise).
    // Its ways are listed counter-clockwise (member order is no riding
    // direction: no forward/backward roles), so ride the chain reversed, as
    // signed.
    relation: 18146670,
    reverse: true,
  },
  {
    id: 'scenic-hangzhou-west-lake',
    // Lakeshore roads and the Yanggong causeway (the Su causeway is foot-only).
    // Starts and ends on Beishan Street at the Broken Bridge, so the loop
    // closes on the through road instead of turning round at the bridge.
    waypoints: [[30.26183, 120.14905], [30.2600, 120.1380], [30.2426, 120.1311], [30.2339, 120.1450], [30.2500, 120.1640], [30.26183, 120.14905]],
  },
  {
    id: 'scenic-cuyahoga-towpath',
    // Points on the towpath itself so the router never swaps to Riverview Road.
    waypoints: [[41.3180, -81.5858], [41.3000, -81.5719], [41.2799, -81.5616], [41.2633, -81.5585], [41.2428, -81.5504], [41.2300, -81.5524], [41.2100, -81.5670], [41.1900, -81.5773]],
  },
  {
    id: 'scenic-cuyahoga-towpath-north',
    // The towpath north of the first one: Lock 39 at Rockside Road south to
    // Station Road Bridge, where scenic-cuyahoga-towpath starts. Every point
    // is on the towpath, so the router stays on it the whole way.
    waypoints: [[41.3940, -81.6278], [41.3742, -81.6123], [41.3560, -81.5967], [41.3335, -81.5887], [41.3195, -81.5859]],
  },
  {
    id: 'scenic-cleveland-lakefront',
    // Points taken from the signed bikeway (OSM relation 13620723).
    waypoints: [[41.4896, -81.7351], [41.4889, -81.7200], [41.4923, -81.7057], [41.5100, -81.6898], [41.5169, -81.6800], [41.5213, -81.6696], [41.5258, -81.6611], [41.5326, -81.6501], [41.5386, -81.6399]],
  },
  {
    id: 'scenic-wendy-park-lakewood',
    // West from Wendy Park at the river mouth: Whiskey Island, the lakefront
    // bikeway's first stretch, the Edgewater Park trail, Edgewater Drive and
    // Lake Avenue to Lakewood Park. Points are on those paths and streets
    // (taken from a routed-bike run), so nothing snaps into the lake. It
    // starts at the foot of the Wendy Park bridge's spiral ramp: riding the
    // spiral down would pass under the bridge 30 m from its abutment, at
    // ground the DEM doesn't lift.
    waypoints: [[41.49905, -81.71255], [41.4968, -81.7160], [41.48916, -81.73612], [41.48683, -81.74532], [41.48824, -81.75776], [41.49136, -81.77326], [41.49256, -81.78893], [41.49350, -81.79834]],
  },
  {
    id: 'scenic-berkeley-bay-trail',
    waypoints: [[37.9007, -122.3247], [37.8718, -122.3189], [37.8403, -122.3149]],
  },
  {
    id: 'scenic-santa-monica-strand',
    waypoints: [[34.0089, -118.4974], [33.9867, -118.4741], [33.9587, -118.4523], [33.8839, -118.4132], [33.8616, -118.4037]],
  },
  {
    id: 'scenic-puerto-vallarta-malecon',
    // North along the bay. The coast road south to Mismaloya climbs the cliffs; skipped.
    waypoints: [[20.6043, -105.2385], [20.6104, -105.2351], [20.6183, -105.2324], [20.6684, -105.2487]],
  },
];

const OSRM_BIKE = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/';

/** The OSRM query the generator sends for these waypoints (its first choice of router). */
export function osrmRouteUrl(waypoints) {
  const coords = waypoints.map(([lat, lon]) => `${lon},${lat}`).join(';');
  return `${OSRM_BIKE}${coords}?overview=full&geometries=geojson&steps=true`;
}

export function scenicRouteSource(id) {
  return SCENIC_ROUTE_SOURCES.find((r) => r.id === id) ?? null;
}

/**
 * The credit a world bundle carries for one of its routes: the OSM relation
 * it follows, or the OSRM bike query that routed it (both reproduce the
 * geometry; the route data is © OpenStreetMap contributors, ODbL).
 */
export function routeSourceCredit(id, name) {
  const src = scenicRouteSource(id);
  if (!src) throw new Error(`route ${id} has no entry in scripts/scenicRouteSources.mjs`);
  if (src.relation) {
    return {
      id: `route-${id}`,
      name: `${name}: OpenStreetMap cycle route relation ${src.relation}${src.reverse ? ', ridden against its member order' : ''}`,
      licence: 'ODbL-1.0',
      url: `https://www.openstreetmap.org/relation/${src.relation}`,
      attribution: `Route geometry from OpenStreetMap relation ${src.relation}, © OpenStreetMap contributors`,
    };
  }
  return {
    id: `route-${id}`,
    name: `${name}: OSRM bike route through ${src.waypoints.length} waypoints, routing.openstreetmap.de`,
    licence: 'Route geometry derived from OpenStreetMap (ODbL-1.0)',
    url: osrmRouteUrl(src.waypoints),
    attribution: 'Routed with OSRM on routing.openstreetmap.de (FOSSGIS e.V.) from © OpenStreetMap contributors',
  };
}
