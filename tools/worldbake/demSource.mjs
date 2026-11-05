// Which DEM a world is baked from: the recipe's `dem.source`.
//
//   "aws-terrain-tiles" (default when `source` is absent): Terrain Tiles
//       terrarium PNGs at `dem.zoom` (EU-DEM in Europe), fetchDem.mjs.
//   "copernicus-glo30": Copernicus DEM GLO-30 COGs, 1 arc-second, no zoom,
//       fetchGlo30.mjs.
//
// Both return the same sampler shape (sample(lat, lon) → metres, bilinear on
// the source's pixel centres), so buildHeightfield.sampleGrid resamples either
// onto the world grid the same way.

export const DEFAULT_DEM_SOURCE = 'aws-terrain-tiles';
export const GLO30_DEM_SOURCE = 'copernicus-glo30';
export const DEM_SOURCES = [DEFAULT_DEM_SOURCE, GLO30_DEM_SOURCE];

/** The recipe's DEM source id, after checking `dem` fits it. */
export function demSourceOf(recipe) {
  const dem = recipe.dem;
  if (!dem || typeof dem !== 'object') throw new Error('recipe needs a "dem" object');
  const source = dem.source ?? DEFAULT_DEM_SOURCE;
  if (!DEM_SOURCES.includes(source)) throw new Error(`recipe dem.source "${source}" is not one of ${DEM_SOURCES.join(', ')}`);
  if (source === DEFAULT_DEM_SOURCE && !Number.isInteger(dem.zoom)) throw new Error('recipe dem.zoom (an integer) is required for the aws-terrain-tiles source');
  if (source === GLO30_DEM_SOURCE && dem.zoom !== undefined) throw new Error('recipe dem.zoom only applies to aws-terrain-tiles; drop it for copernicus-glo30');
  return source;
}
