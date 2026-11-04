/**
 * The route guide: a thin line painted down the middle of the road the rider
 * follows, with faint chevrons every few metres pointing the way, so a bend
 * reads as a bend and a turn as a turn. It is paint on the road, not a second
 * road: the ribbon under it is invisible except where the paint is.
 *
 * Drawn on the route ribbon (uv.x 0…1 across, uv.y metres along the route in
 * the direction of travel). The vertex stage shares the road decal's capped
 * depth pull (see road.ts), so the paint never shows through a building.
 */

import * as THREE from 'three';
import { createAtmosphere, patchWorldMaterial, type WorldAtmosphere } from './atmosphere';

/**
 * The paint colour: the warm-atlas terracotta, `--primary` of the paper theme
 * in src/index.css (docs/design/v2-identity.md: one accent marks the route
 * line). Fixed rather than read from the page, so the paint on a sunlit road
 * doesn't change with the UI theme (the night theme's lighter terracotta
 * washes out to pink on a pale path). HSL in sRGB, like the CSS token.
 */
export const ROUTE_PAINT_HSL = { h: 14, s: 64, l: 42 } as const;

/** ROUTE_PAINT_HSL as a three.js (linear) colour. */
export function routePaintColor(): THREE.Color {
  const { h, s, l } = ROUTE_PAINT_HSL;
  return new THREE.Color().setHSL(h / 360, s / 100, l / 100, THREE.SRGBColorSpace);
}

/** Paint geometry, metres. The ribbon it sits on is ROUTE_WIDTH_M wide. */
export const ROUTE_GUIDE = {
  /** Half-width of the centre line (a 10 cm line, like road paint). */
  lineHalfM: 0.05,
  /** Chevron spacing along the route. */
  chevronEveryM: 7,
  /** Chevron arm reach either side of the centre line. */
  chevronHalfM: 0.24,
  /**
   * How far back the arms sweep per metre of reach. Long arms (about 20° off
   * the line) still read as an arrowhead from a chase camera's grazing view.
   */
  chevronSweep: 2.6,
  /** Chevron stroke half-width. */
  chevronStrokeM: 0.045,
  /** The centre line stops this far either side of a chevron, so it reads as an arrow, not a cross. */
  chevronGapM: 0.35,
  /** Opacity of the line and of the chevrons. */
  lineAlpha: 0.7,
  chevronAlpha: 0.8,
} as const;

export interface RouteGuideOptions {
  /** Paint colour (linear); defaults to routePaintColor(). */
  color?: THREE.Color;
  /** Ribbon width the uv spans, metres. */
  widthM: number;
  bias?: number;
  biasPerM?: number;
  maxPull?: number;
  atmo?: WorldAtmosphere;
}

export function createRouteGuideMaterial(opts: RouteGuideOptions): THREE.MeshStandardMaterial {
  const color = opts.color ?? routePaintColor();
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    // A little self-light so the paint still reads in shade and at dusk.
    emissive: color.clone().multiplyScalar(0.05),
  });
  const g = ROUTE_GUIDE;
  const uniforms = {
    uBias: { value: opts.bias ?? 0.12 },
    uBiasPerM: { value: opts.biasPerM ?? 0.0025 },
    uMaxPull: { value: opts.maxPull ?? 1e6 },
    uGuideWidth: { value: opts.widthM },
  };
  const onShader = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uBias;
uniform float uBiasPerM;
uniform float uMaxPull;
varying vec2 vGuideUv;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  vGuideUv = uv;
  {
    float d = length(mvPosition.xyz);
    float pull = min(min(d * 0.5, uBias + d * uBiasPerM), uMaxPull);
    mvPosition.xyz *= (d - pull) / max(d, 1e-4);
    gl_Position = projectionMatrix * mvPosition;
  }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uGuideWidth;
varying vec2 vGuideUv;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    // Metres from the centre line, and along the route.
    float across = (vGuideUv.x - 0.5) * uGuideWidth;
    float along = vGuideUv.y;
    float pxA = max(fwidth(across), 1e-4);
    float pxL = max(fwidth(along), 1e-4);
    // Centre line: never thinner than ~1 px, fainter when it would be.
    float lineHalf = max(${g.lineHalfM.toFixed(3)}, pxA * 0.75);
    float line = (1.0 - smoothstep(lineHalf - pxA, lineHalf + pxA, abs(across))) * (${g.lineHalfM.toFixed(3)} / lineHalf);
    // Chevrons pointing along the route: arms sweep back from the tip.
    float p = mod(along, ${g.chevronEveryM.toFixed(1)});
    float arm = abs(p - (${(g.chevronEveryM * 0.5).toFixed(2)} - abs(across) * ${g.chevronSweep.toFixed(2)})) / ${Math.hypot(1, g.chevronSweep).toFixed(4)};
    // Chevrons fade out before they shrink to a few pixels (no shimmer far off).
    float chevVis = 1.0 - smoothstep(0.05, 0.14, pxL);
    // Gap in the centre line from just behind the arm ends to just past the
    // tip, so a chevron reads as an arrow, not a cross (only where it shows).
    float gapLo = ${(g.chevronEveryM * 0.5 - g.chevronHalfM * g.chevronSweep - g.chevronGapM).toFixed(3)};
    float gapHi = ${(g.chevronEveryM * 0.5 + g.chevronGapM).toFixed(3)};
    line *= 1.0 - chevVis * (smoothstep(gapLo - pxL, gapLo + pxL, p) - smoothstep(gapHi - pxL, gapHi + pxL, p));
    float stroke = ${g.chevronStrokeM.toFixed(3)};
    float pxArm = max(fwidth(arm), 1e-4);
    float chev = (1.0 - smoothstep(stroke - pxArm, stroke + pxArm, arm))
      * (1.0 - smoothstep(${g.chevronHalfM.toFixed(3)} - pxA, ${g.chevronHalfM.toFixed(3)} + pxA, abs(across)))
      * chevVis;
    float paint = max(line * ${g.lineAlpha.toFixed(2)}, chev * ${g.chevronAlpha.toFixed(2)});
    if (paint < 0.01) discard;
    diffuseColor.a *= paint;
  }`,
      );
  };
  patchWorldMaterial(mat, opts.atmo ?? createAtmosphere(), { key: 'route-guide-v3', onShader });
  return mat;
}
