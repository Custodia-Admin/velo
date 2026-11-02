// Vector source: OpenStreetMap via the Overpass API (key-free). Every query is
// pinned to the recipe's `osmDate` with Overpass attic data ([date:...]), so a
// bake from a clean cache sees the same OSM state as the last one. Raw
// responses are cached under tools/worldbake/cache/overpass (git-ignored).
//
// Data © OpenStreetMap contributors, ODbL 1.0.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cachedFetch, ensureDir, sha256, sleep } from './util.mjs';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Overpass QL bodies per layer; `{{bbox}}` is replaced with south,west,north,east. */
export const OSM_LAYERS = {
  roads:
    'way[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian|track|cycleway|path|footway|bridleway|steps)$"]({{bbox}});out geom;',
  water:
    '(way[natural=water]({{bbox}});relation[natural=water]({{bbox}});way[waterway~"^(river|stream|canal|riverbank)$"]({{bbox}});relation[waterway=riverbank]({{bbox}}););out geom;',
  landcover:
    '(way[landuse~"^(forest|farmland|meadow|grass|orchard|vineyard|residential|industrial|commercial|retail|farmyard|allotments|cemetery|recreation_ground|village_green|quarry)$"]({{bbox}});relation[landuse~"^(forest|farmland|meadow|grass|orchard|vineyard|residential|industrial|commercial|retail)$"]({{bbox}});way[natural~"^(wood|scrub|grassland|heath)$"]({{bbox}});relation[natural~"^(wood|scrub|grassland)$"]({{bbox}});way[leisure~"^(park|garden|golf_course|pitch)$"]({{bbox}}););out geom;',
  buildings: '(way[building]({{bbox}});relation[building]({{bbox}}););out geom;',
  treerows: 'way[natural=tree_row]({{bbox}});out geom;',
  pois:
    '(node[place~"^(city|town|village|hamlet|suburb)$"]({{bbox}});node[natural=peak][name]({{bbox}});node[tourism=viewpoint]({{bbox}});node[historic~"^(castle|monument|tower|city_gate|fort|archaeological_site)$"][name]({{bbox}});node[amenity=place_of_worship][name][wikidata]({{bbox}});node[tourism=attraction][name][wikidata]({{bbox}}););out;',
  landmarks:
    '(way[historic~"^(castle|monument|tower|city_gate|fort|archaeological_site)$"][name]({{bbox}});way[amenity=place_of_worship][name][wikidata]({{bbox}});way[tourism=attraction][name][wikidata]({{bbox}});relation[amenity=place_of_worship][name][wikidata]({{bbox}}););out center;',
};

export function overpassQuery(layer, bbox, osmDate) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:300][date:"${osmDate}"];${OSM_LAYERS[layer].replaceAll('{{bbox}}', b)}`;
}

/** Fetch every layer sequentially (Overpass etiquette: one slot at a time). */
export async function fetchOsm({ bbox, osmDate, cacheDir, log = () => {} }) {
  const dir = join(cacheDir, 'overpass');
  ensureDir(dir);
  const out = {};
  const queries = {};
  for (const layer of Object.keys(OSM_LAYERS)) {
    const q = overpassQuery(layer, bbox, osmDate);
    queries[layer] = q;
    const t0 = Date.now();
    const { body, cached } = await cachedFetch(
      dir,
      `${layer}-${sha256(q).slice(0, 16)}.json`,
      OVERPASS_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(q)}`,
      },
      { label: `overpass ${layer}` },
    );
    const key = join(dir, `${layer}-${sha256(q).slice(0, 16)}.json`);
    let json;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch (err) {
      rmSync(key, { force: true });
      throw new Error(`overpass ${layer}: response is not JSON`, { cause: err });
    }
    if (json.remark && /error|timed out|runtime/i.test(json.remark)) {
      // A partial answer must never be cached as the truth.
      rmSync(key, { force: true });
      throw new Error(`overpass ${layer}: ${json.remark}`);
    }
    out[layer] = json.elements;
    log(`osm: ${layer} ${json.elements.length} elements (${cached ? 'cache' : `${((Date.now() - t0) / 1000).toFixed(1)} s`})`);
    if (!cached) await sleep(2000);
  }
  return { elements: out, queries };
}
