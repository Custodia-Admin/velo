/**
 * asphaltMaterial.test.ts — contract tests for the asphalt MaterialProperty.
 *
 * These cover the ride-view crash regression (t_631dac35): entity graphics
 * only accept MaterialProperty values; a raw fabric Cesium.Material throws
 * "Unable to infer material type" in Cesium's debug build and is silently
 * dropped in release builds.  No WebGL context is required — Cesium.Material
 * and Entity are pure data until they reach a scene.
 */

import { describe, it, expect } from 'vitest';
import * as Cesium from 'cesium';
import {
  ASPHALT_MATERIAL_TYPE,
  AsphaltMaterialProperty,
  createAsphaltMaterialProperty,
} from './asphaltMaterial';

// Cesium's uniform-type sniffing and material-property conversion reference
// DOM image/canvas classes that do not exist in the node test environment.
// Inert placeholders are enough — no test uniform is a DOM element.
for (const name of [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'HTMLVideoElement',
  'ImageBitmap',
  'OffscreenCanvas',
]) {
  if (!(name in globalThis)) {
    (globalThis as Record<string, unknown>)[name] = class {};
  }
}

interface CacheEntry {
  fabric: { type?: string; source?: string; uniforms?: Record<string, unknown> };
  translucent: boolean | ((material: unknown) => boolean);
}

function cacheEntry(type: string): CacheEntry | undefined {
  const cache = (Cesium.Material as unknown as {
    _materialCache: { getMaterial(t: string): CacheEntry | undefined };
  })._materialCache;
  return cache.getMaterial(type);
}

// ---------------------------------------------------------------------------
// Material-cache registration
// ---------------------------------------------------------------------------

describe('asphalt material registration', () => {
  it('registers the fabric type in the Cesium material cache', () => {
    createAsphaltMaterialProperty(1000, 2000);
    const entry = cacheEntry(ASPHALT_MATERIAL_TYPE);
    expect(entry).toBeDefined();
    expect(entry?.fabric.source).toContain('czm_getMaterial');
    expect(entry?.fabric.source).toContain('u_extentMeters');
    expect(entry?.fabric.uniforms).toHaveProperty('u_roughness');
    expect(entry?.translucent).toBe(false);
  });

  it('Material.fromType builds the asphalt material from the registered type', () => {
    createAsphaltMaterialProperty(1, 1); // ensure registered
    const material = Cesium.Material.fromType(ASPHALT_MATERIAL_TYPE);
    expect(material.type).toBe(ASPHALT_MATERIAL_TYPE);
    expect(material.uniforms).toHaveProperty('u_roughness');
    expect(material.uniforms).toHaveProperty('u_extentMeters');
  });
});

// ---------------------------------------------------------------------------
// MaterialProperty contract
// ---------------------------------------------------------------------------

describe('AsphaltMaterialProperty', () => {
  it('reports the registered type and fills the shader uniforms', () => {
    const prop = createAsphaltMaterialProperty(1234, 5678);
    const time = Cesium.JulianDate.now();
    expect(prop.getType(time)).toBe(ASPHALT_MATERIAL_TYPE);

    const uniforms = prop.getValue(time, {}) as Record<string, unknown>;
    expect(uniforms.u_roughness).toBeCloseTo(0.07);
    const extent = uniforms.u_extentMeters as Cesium.Cartesian2;
    expect(extent).toBeInstanceOf(Cesium.Cartesian2);
    expect(extent.x).toBeCloseTo(1234);
    expect(extent.y).toBeCloseTo(5678);
  });

  it('honours a custom roughness', () => {
    const prop = createAsphaltMaterialProperty(10, 10, 0.2);
    const uniforms = prop.getValue(Cesium.JulianDate.now(), {}) as Record<string, unknown>;
    expect(uniforms.u_roughness).toBeCloseTo(0.2);
  });

  it('is constant, exposes definitionChanged and compares by value', () => {
    const a = createAsphaltMaterialProperty(100, 200);
    const b = createAsphaltMaterialProperty(100, 200);
    const c = createAsphaltMaterialProperty(100, 201);
    expect(a.isConstant).toBe(true);
    expect(a.definitionChanged).toBeInstanceOf(Cesium.Event);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals(undefined as unknown as Cesium.Property)).toBe(false);
    expect(a).toBeInstanceOf(AsphaltMaterialProperty);
  });

  it('clamps degenerate extents to at least 1 m', () => {
    const prop = createAsphaltMaterialProperty(0, -5);
    const uniforms = prop.getValue(Cesium.JulianDate.now(), {}) as Record<string, unknown>;
    const extent = uniforms.u_extentMeters as Cesium.Cartesian2;
    expect(extent.x).toBeGreaterThanOrEqual(1);
    expect(extent.y).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Regression: the t_631dac35 crash
// ---------------------------------------------------------------------------

describe('entity graphics material acceptance', () => {
  const positions = [
    Cesium.Cartesian3.fromDegrees(8.95, 46.0),
    Cesium.Cartesian3.fromDegrees(8.96, 46.01),
  ];

  it('a raw fabric Cesium.Material is rejected by CorridorGraphics (the dev crash)', () => {
    const raw = new Cesium.Material({
      fabric: {
        uniforms: { u_x: 1.0 },
        source:
          'czm_material czm_getMaterial(czm_materialInput mi) { return czm_getDefaultMaterial(mi); }',
      },
    });
    // Vitest resolves Cesium's source build, which keeps the debug guard:
    // entity graphics throw on a raw Material (vite dev does the same; the
    // minified release build instead drops it silently).
    expect(
      () =>
        new Cesium.Entity({
          corridor: { positions, material: raw as unknown as Cesium.MaterialProperty },
        }),
    ).toThrow(/Unable to infer material type/);
  });

  it('AsphaltMaterialProperty is accepted and retained by CorridorGraphics', () => {
    const prop = createAsphaltMaterialProperty(500, 900);
    const entity = new Cesium.Entity({
      corridor: {
        positions,
        width: 7,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: prop,
      },
    });
    expect(entity.corridor?.material).toBe(prop);
  });
});
