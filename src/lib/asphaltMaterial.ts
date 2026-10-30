/**
 * asphaltMaterial.ts — asphalt road-surface material for route corridors.
 *
 * Cesium entity graphics (`CorridorGraphics`) only accept `MaterialProperty`
 * values.  Passing a fabric `Cesium.Material` directly (what this module used
 * to export) makes Cesium's debug build (vite dev) throw
 * "Unable to infer material type" when the entity is added, and the release
 * build silently drops the material — the corridor then renders with the
 * default white appearance and no asphalt ever shows.
 *
 * The asphalt shader is therefore exposed as a proper MaterialProperty:
 *
 *   • The fabric shader is registered once in Cesium's material type cache
 *     under `ASPHALT_MATERIAL_TYPE`.  The entity pipeline builds the real
 *     Material via `Material.fromType()`; this works for plain and for
 *     ground-clamped corridors (GroundPrimitive + ShadowVolumeAppearance
 *     support fabric materials).
 *   • `AsphaltMaterialProperty` implements the MaterialProperty contract
 *     (getType / getValue / equals) so Cesium feeds the uniforms.
 *
 * Texture-coordinate caveat — why road markings are not baked into this
 * shader: for ground-clamped corridors Cesium ignores the corridor's own
 * per-vertex UVs and remaps `materialInput.st` to the corridor's bounding
 * box (st.x = west→east, st.y = south→north across the whole route extent;
 * `CorridorGeometry.textureCoordinateRotationPoints` is the identity).
 * Road-local markings (edge bands, centre dashes, gradient tint keyed to
 * route position) cannot be expressed with that st — they would smear across
 * the bounding box on any winding route.  The shader instead converts st to
 * metres via the `u_extentMeters` uniform and renders metre-scale asphalt
 * granules; markings live as entities (dashed centreline + edge stripes, see
 * routeSurface.ts) and gradient severity is carried by the gradient
 * polylines, climb arches and HUD.
 *
 * No WebGL context is needed to import this module or to construct the
 * property; Cesium builds the Material lazily inside its geometry pipeline.
 */

import * as Cesium from 'cesium';

/** Name the asphalt fabric shader is registered under in Cesium's material cache. */
export const ASPHALT_MATERIAL_TYPE = 'VeloAsphalt';

// ---------------------------------------------------------------------------
// GLSL — metre-scale asphalt granules
// ---------------------------------------------------------------------------

const ASPHALT_GLSL = `
uniform float u_roughness;
uniform vec2 u_extentMeters;

czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);

  // st is the route bounding-box UV (0..1) on ground-clamped corridors;
  // convert to local ENU metres so granule scale is metric for any route.
  vec2 meters = materialInput.st * u_extentMeters;

  // Cheap noise: layered sine hash that reads as fine asphalt granules
  // (~0.15–0.35 m wavelengths).
  float n = sin(meters.x * 41.7 + meters.y * 23.3) * 0.5
          + sin(meters.x * 17.3 - meters.y * 31.1) * 0.3
          + sin(meters.x * 63.9 + meters.y * 8.7) * 0.2;
  n = n * 0.5 + 0.5; // remap to [0,1]

  // Coarse mottling (~7–10 m) so long stretches do not read as flat paint.
  float mottle = sin(meters.x * 0.71 + 1.7) * sin(meters.y * 0.93 + 4.1);

  // Base asphalt colour: very dark grey, subtly warm.
  vec3 base = vec3(0.13, 0.12, 0.11);
  vec3 colour = base
    + vec3(n * u_roughness - u_roughness * 0.5)
    + vec3(mottle * 0.012);

  material.diffuse   = colour;
  material.specular  = 0.06;
  material.shininess = 6.0;
  material.alpha     = 1.0;
  return material;
}
`;

// ---------------------------------------------------------------------------
// Material-cache registration
// ---------------------------------------------------------------------------

interface MaterialCache {
  getMaterial(type: string): unknown;
  addMaterial(type: string, template: unknown): void;
}

let asphaltTypeRegistered = false;

/**
 * Register the asphalt fabric shader in Cesium's (private) material type
 * cache, once.  `Material.fromType(ASPHALT_MATERIAL_TYPE)` — which the entity
 * pipeline uses to build the material for a MaterialProperty — only resolves
 * types present in that cache.
 */
function ensureAsphaltTypeRegistered(): void {
  if (asphaltTypeRegistered) return;
  const cache = (Cesium.Material as unknown as { _materialCache: MaterialCache })._materialCache;
  if (!cache.getMaterial(ASPHALT_MATERIAL_TYPE)) {
    cache.addMaterial(ASPHALT_MATERIAL_TYPE, {
      fabric: {
        type: ASPHALT_MATERIAL_TYPE,
        uniforms: {
          u_roughness: 0.07,
          u_extentMeters: new Cesium.Cartesian2(1.0, 1.0),
        },
        source: ASPHALT_GLSL,
      },
      // The road surface is opaque; keeps ground corridors out of the
      // translucent classification path.
      translucent: false,
    });
  }
  asphaltTypeRegistered = true;
}

// ---------------------------------------------------------------------------
// AsphaltMaterialProperty
// ---------------------------------------------------------------------------

/**
 * MaterialProperty mapping to the asphalt fabric shader's uniforms.
 * Constant over time — the entity pipeline builds the Material once per
 * geometry batch via `Material.fromType()` and feeds it `getValue()`.
 */
export class AsphaltMaterialProperty implements Cesium.MaterialProperty {
  private readonly _definitionChanged = new Cesium.Event();
  private readonly _roughness: number;
  private readonly _extentEastMeters: number;
  private readonly _extentNorthMeters: number;

  /**
   * @param extentEastMeters  east–west span of the route bounding box in metres.
   * @param extentNorthMeters north–south span of the route bounding box in metres.
   * @param roughness         granule contrast amplitude (0–1).  Default 0.07.
   */
  constructor(extentEastMeters: number, extentNorthMeters: number, roughness = 0.07) {
    // Degenerate extents (single-point routes) would collapse the noise
    // scale; keep at least 1 m so the shader stays well-defined.
    this._extentEastMeters = Math.max(1, Number.isFinite(extentEastMeters) ? extentEastMeters : 1);
    this._extentNorthMeters = Math.max(1, Number.isFinite(extentNorthMeters) ? extentNorthMeters : 1);
    this._roughness = roughness;
  }

  get isConstant(): boolean {
    return true;
  }

  get definitionChanged(): Cesium.Event {
    return this._definitionChanged;
  }

  getType(_time: Cesium.JulianDate): string {
    return ASPHALT_MATERIAL_TYPE;
  }

  getValue(_time?: Cesium.JulianDate, result?: Record<string, unknown>): Record<string, unknown> {
    const out = result ?? {};
    out.u_roughness = this._roughness;
    out.u_extentMeters = new Cesium.Cartesian2(this._extentEastMeters, this._extentNorthMeters);
    return out;
  }

  equals(other?: Cesium.Property): boolean {
    return (
      this === other ||
      (other instanceof AsphaltMaterialProperty &&
        other._roughness === this._roughness &&
        other._extentEastMeters === this._extentEastMeters &&
        other._extentNorthMeters === this._extentNorthMeters)
    );
  }
}

/**
 * Create an asphalt MaterialProperty for a road corridor covering a route
 * with the given bounding-box extent.  Pass the output of
 * `routeExtentMeters()` (routeSurface.ts).
 */
export function createAsphaltMaterialProperty(
  extentEastMeters: number,
  extentNorthMeters: number,
  roughness = 0.07,
): AsphaltMaterialProperty {
  ensureAsphaltTypeRegistered();
  return new AsphaltMaterialProperty(extentEastMeters, extentNorthMeters, roughness);
}
