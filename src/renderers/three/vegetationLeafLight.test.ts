import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createAtmosphere } from './materials/atmosphere';
import {
  TREE_COLORS,
  TREE_LEAF_LUMA,
  TREE_LEAF_TRANSMIT,
  TREE_LEAF_TRANSMIT_FACING,
  TREE_LEAF_TRANSMIT_GLSL,
  TREE_LEAF_TRANSMIT_KNEE,
  createTreeMaterial,
  treeLeafTransmit,
  treeLeafTransmitWeight,
} from './Vegetation';

function compiled(mat: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

const luma = (c: readonly number[]) => c[0] * TREE_LEAF_LUMA[0] + c[1] * TREE_LEAF_LUMA[1] + c[2] * TREE_LEAF_LUMA[2];
const linear = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

describe('skylight through the leaves lights a crown where the sky does not', () => {
  it('weights the underside and shaded sides of a crown, not its top', () => {
    expect(treeLeafTransmitWeight(-1)).toBe(1);
    expect(treeLeafTransmitWeight(TREE_LEAF_TRANSMIT_FACING.full)).toBe(1);
    expect(treeLeafTransmitWeight(TREE_LEAF_TRANSMIT_FACING.none)).toBe(0);
    expect(treeLeafTransmitWeight(1)).toBe(0);
    expect(treeLeafTransmitWeight((TREE_LEAF_TRANSMIT_FACING.full + TREE_LEAF_TRANSMIT_FACING.none) / 2)).toBeCloseTo(0.5, 5);
    // The whole underside, most of a side-on face (the near avenue crowns are seen side-on), none of the top.
    expect(TREE_LEAF_TRANSMIT_FACING.full).toBeGreaterThanOrEqual(-0.5);
    expect(TREE_LEAF_TRANSMIT_FACING.full).toBeLessThan(0);
    expect(treeLeafTransmitWeight(0)).toBeGreaterThan(0.6);
    expect(treeLeafTransmitWeight(0)).toBeLessThan(1);
    expect(treeLeafTransmitWeight(0.8)).toBe(0);
    let prev = Infinity;
    for (let y = -1; y <= 1; y += 0.05) {
      const w = treeLeafTransmitWeight(y);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
  });

  it('gives every species the same brightness, in its own hue', () => {
    const sky: [number, number, number] = [1, 1, 1];
    const want = TREE_LEAF_TRANSMIT / Math.PI;
    // Every palette colour, plus the darkest and lightest autumn tints the shader mixes in.
    const bases = [...Object.values(TREE_COLORS).map(linear), [0.22, 0.14, 0.05] as [number, number, number], [0.32, 0.25, 0.08] as [number, number, number]];
    for (const base of bases) {
      const t = treeLeafTransmit(base, base, sky, -1);
      expect(luma(t)).toBeCloseTo(want, 6);
      // Same hue as the leaf (channel ratios kept).
      expect(t[0] / t[1]).toBeCloseTo(base[0] / base[1], 6);
      expect(t[2] / t[1]).toBeCloseTo(base[2] / base[1], 6);
    }
    // The dark cypress gains as much as the pale olive: neither stays black nor glows.
    const cypress = linear(TREE_COLORS.cypress);
    const olive = linear(TREE_COLORS.olive);
    expect(luma(treeLeafTransmit(cypress, cypress, sky, -1))).toBeCloseTo(luma(treeLeafTransmit(olive, olive, sky, -1)), 9);
    // Leaf clumps keep their light and dark masses (the leaf colour, not the base, is scaled).
    const park = linear(TREE_COLORS.park);
    const dark = park.map((v) => v * 0.62) as [number, number, number];
    expect(luma(treeLeafTransmit(dark, park, sky, -1))).toBeCloseTo(0.62 * want, 6);
    // It follows the sky: half the skylight, half the term; none on a crown's top.
    expect(luma(treeLeafTransmit(park, park, [0.5, 0.5, 0.5], -1))).toBeCloseTo(want / 2, 6);
    expect(luma(treeLeafTransmit(park, park, sky, 1))).toBe(0);
  });

  it('only fills what the light leaves dark, and never flips the shading order', () => {
    const park = linear(TREE_COLORS.park);
    const sky: [number, number, number] = [0.8, 0.9, 1.1];
    const full = treeLeafTransmit(park, park, sky, -1);
    const fill = luma(full);
    expect(fill).toBeGreaterThan(0);
    // A black fragment (the near-black avenue crown) gets all of it…
    expect(luma(treeLeafTransmit(park, park, sky, -1, [0, 0, 0]))).toBeCloseTo(fill, 9);
    // …a crown the sun or the sky already lights (noon) none of it.
    const grey = (l: number): [number, number, number] => [l, l, l];
    expect(luma(treeLeafTransmit(park, park, sky, -1, grey(TREE_LEAF_TRANSMIT_KNEE * fill)))).toBeCloseTo(0, 9);
    expect(luma(treeLeafTransmit(park, park, sky, -1, grey(10 * fill)))).toBe(0);
    // In between it fades smoothly, and lit + term still rises with the lit colour.
    expect(luma(treeLeafTransmit(park, park, sky, -1, grey(0.5 * TREE_LEAF_TRANSMIT_KNEE * fill)))).toBeCloseTo(fill / 2, 6);
    expect(TREE_LEAF_TRANSMIT_KNEE).toBeGreaterThanOrEqual(1.5);
    let prev = -Infinity;
    for (let l = 0; l <= 4 * TREE_LEAF_TRANSMIT_KNEE * fill; l += fill / 50) {
      const out = l + luma(treeLeafTransmit(park, park, sky, -1, grey(l)));
      expect(out).toBeGreaterThan(prev);
      prev = out;
    }
  });

  it.each([false, true])('is in the tree shader (leafy %s), lit like the rest of the colour and before the haze', (leafy) => {
    const shader = compiled(createTreeMaterial(createAtmosphere(), 0, leafy));
    const fs = shader.fragmentShader;
    expect(fs).toContain('uniform float uLeafTransmit;');
    expect(shader.uniforms.uLeafTransmit.value).toBe(TREE_LEAF_TRANSMIT);
    expect(TREE_LEAF_TRANSMIT).toBeGreaterThan(0);
    // Leaf colour after the clump variation, normalised by its species base colour's luminance.
    expect(fs).toContain(`gLeafHue = col / max(dot(base, vec3(${TREE_LEAF_LUMA.join(', ')})), 1e-3);`);
    expect(fs.indexOf('gLeafHue = col')).toBeGreaterThan(fs.indexOf('vec3 col = base * mix('));
    expect(fs.indexOf('gLeafHue = col')).toBeLessThan(fs.indexOf('col *= vAo * vAo'));
    // The term, its sky (env from straight up + hemisphere) and the shader weight that mirrors treeLeafTransmitWeight.
    expect(fs).toContain(TREE_LEAF_TRANSMIT_GLSL);
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('skyUp += getIBLIrradiance(upV);');
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('skyUp += getHemisphereLightIrradiance(hemisphereLights[0], upV);');
    const { full, none } = TREE_LEAF_TRANSMIT_FACING;
    const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain(`float away = 1.0 - smoothstep(${f(full)}, ${f(none)}, dot(normalize(vNormal), upV));`);
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('vec3 leafSky = gLeafHue * skyUp * RECIPROCAL_PI * uLeafTransmit * away * vCrown;');
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain(`vec3 lumaW = vec3(${TREE_LEAF_LUMA.join(', ')});`);
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain(`float knee = ${f(TREE_LEAF_TRANSMIT_KNEE)} * dot(leafSky, lumaW) + 1e-6;`);
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('gl_FragColor.rgb += leafSky * (1.0 - smoothstep(0.0, knee, dot(gl_FragColor.rgb, lumaW)));');
    // After three's lighting and the sun translucency, before the haze and tone mapping.
    const term = fs.indexOf('gl_FragColor.rgb += leafSky');
    expect(term).toBeGreaterThan(fs.indexOf('gSunLit * (back * 0.45 + 0.05)'));
    expect(term).toBeGreaterThan(fs.indexOf('#include <lights_fragment_end>'));
    expect(term).toBeLessThan(fs.indexOf('gl_FragColor.rgb = applyAtmo(gl_FragColor.rgb, vWPos);'));
  });
});

type Rgb = readonly [number, number, number];

/**
 * Measured on the test host: ANGLE gl-egl on the Intel Arrow Lake iGPU, the token-free build of main
 * 84b7d85, Tiber park at 1440×900, medium tier. The rider is held with `__veloWorldLight.place(d)`,
 * the light pinned with `.set({ time, weather })` and the tree sway frozen. Taken 5 Nov 2026, so
 * autumn is 0.45. The probe scripts are kept outside the repo.
 *
 * - `skyUp`: the sky irradiance from straight up that the tree shader sees (env IBL + hemisphere,
 *   before three's ÷π). It is read back exactly from the scene's own environment and hemisphere light.
 * - `exposure`: `gl.toneMappingExposure`. Medium has no post pass, so three's ACES filmic
 *   (`gl.toneMapping` 4) and the sRGB output make the screen colour (`display`).
 * - `term` rows: one crown pixel per stratum of normal × lit/term (lit/term < 0.8), at any distance.
 *   Raw 8-bit codes: leaf hue R G B (`gLeafHue` × ¼), normal (½ + ½ normal·world up),
 *   lit R G B (× 8, term off), then lit with the term R G B (× 8). "Lit" is what the knee sees: after
 *   three's lighting and the sun translucency, before the haze.
 * - `display` rows: the near-crown pixels (< 12 m, no haze) at the 10th and 50th percentile of
 *   luminance. Raw codes: leaf hue R G B, normal, lit R G B (× 2, term off), then the screen pixel
 *   before (term off) and after, in sRGB.
 */
interface MeasuredLight {
  what: string;
  skyUp: Rgb;
  exposure: number;
  term: number[][];
  display: number[][];
}

const MEASURED: MeasuredLight[] = [
  {
    what: 'golden hour, 8,920 m (the avenue crowns that were near-black)',
    skyUp: [5.6429, 4.0701, 3.345],
    exposure: 0.5896,
    term: [
      [116, 141, 73, 158, 74, 86, 72, 148, 159, 96],
      [123, 150, 79, 159, 149, 141, 100, 182, 178, 114],
      [113, 137, 72, 164, 84, 95, 78, 147, 158, 98],
      [138, 137, 77, 169, 134, 128, 92, 181, 164, 106],
      [116, 142, 74, 179, 74, 93, 80, 139, 154, 99],
      [141, 139, 77, 181, 124, 130, 106, 167, 160, 116],
      [113, 137, 72, 198, 86, 110, 86, 107, 128, 91],
    ],
    display: [
      [119, 144, 76, 156, 35, 41, 34, 3, 4, 3, 24, 28, 9],
      [120, 146, 77, 181, 38, 50, 45, 4, 7, 6, 21, 26, 11],
    ],
  },
  {
    what: 'golden hour, 8,980 m',
    skyUp: [5.5914, 4.0601, 3.345],
    exposure: 0.5896,
    term: [
      [146, 136, 78, 150, 104, 103, 81, 186, 160, 104],
      [136, 127, 72, 146, 107, 99, 77, 176, 150, 97],
      [116, 141, 73, 166, 81, 93, 74, 149, 160, 97],
      [135, 126, 72, 168, 111, 111, 88, 171, 152, 104],
      [136, 127, 73, 182, 122, 121, 95, 159, 146, 104],
      [108, 132, 69, 197, 90, 110, 86, 108, 126, 91],
    ],
    display: [
      [144, 135, 77, 146, 52, 50, 38, 9, 8, 4, 36, 27, 10],
      [134, 125, 71, 181, 61, 61, 47, 13, 13, 7, 26, 22, 10],
    ],
  },
  {
    what: 'noon, 8,920 m',
    skyUp: [10.3117, 12.2199, 15.5283],
    exposure: 0.4236,
    term: [
      [100, 122, 63, 154, 189, 222, 202, 204, 244, 210],
    ],
    display: [
      [114, 139, 72, 147, 106, 127, 111, 33, 46, 37, 42, 60, 42],
      [106, 129, 67, 164, 122, 146, 127, 43, 59, 47, 44, 59, 47],
    ],
  },
  {
    what: 'noon, 8,980 m',
    skyUp: [10.4564, 12.3173, 15.5707],
    exposure: 0.4236,
    term: [],
    display: [
      [140, 130, 75, 138, 144, 152, 127, 58, 63, 48, 59, 64, 49],
      [152, 142, 82, 148, 169, 175, 138, 76, 81, 56, 76, 81, 56],
    ],
  },
  {
    what: 'golden hour overcast, 8,920 m',
    skyUp: [3.8252, 3.9655, 4.1073],
    exposure: 0.62,
    term: [
      [116, 141, 74, 138, 128, 138, 118, 148, 166, 128],
      [108, 132, 69, 162, 127, 140, 113, 140, 158, 120],
      [117, 143, 75, 180, 139, 157, 119, 145, 165, 121],
    ],
    display: [
      [116, 141, 74, 140, 64, 70, 58, 17, 20, 14, 24, 31, 18],
      [123, 149, 78, 158, 68, 77, 59, 19, 24, 14, 27, 36, 19],
    ],
  },
  {
    what: 'dawn, 8,920 m',
    skyUp: [3.0565, 1.7784, 1.6528],
    exposure: 0.6127,
    term: [
      [113, 138, 72, 120, 86, 88, 91, 114, 114, 97],
      [111, 136, 71, 165, 83, 94, 101, 107, 113, 106],
      [117, 142, 72, 183, 95, 90, 60, 114, 108, 66],
    ],
    display: [
      [112, 136, 71, 121, 56, 46, 35, 11, 6, 3, 16, 11, 4],
      [116, 141, 73, 154, 146, 103, 51, 74, 43, 12, 74, 43, 12],
    ],
  },
];

/**
 * Normal world-up deciles (p10 … p90) of the near avenue crowns' pixels (< 12 m) the chase camera
 * sees at golden hour. Same probe. They are seen side-on and from below: 42 % (8,920 m) and 49 %
 * (8,980 m) face up more than −0.3; the most up-facing ones are 0.05 and 0.13.
 */
const AVENUE_NORMAL_UP_DECILES = {
  8920: [-0.717, -0.523, -0.425, -0.363, -0.326, -0.297, -0.258, -0.227, -0.121],
  8980: [-0.546, -0.475, -0.416, -0.363, -0.307, -0.267, -0.247, -0.186, -0.121],
} as const;
const AVENUE_NORMAL_UP_MAX = 0.129;

const srgbDecode = (code: number) => {
  const v = code / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const codes = (row: number[], at: number, scale: number, nudge = 0): Rgb => [
  srgbDecode(row[at] + nudge) * scale,
  srgbDecode(row[at + 1] + nudge) * scale,
  srgbDecode(row[at + 2] + nudge) * scale,
];
const normalUpOf = (code: number) => srgbDecode(code) * 2 - 1;
/** Luminance 1: passes a hue that is already normalised (`gLeafHue`) straight through. */
const UNIT_BASE: Rgb = [1, 1, 1];
const add = (a: Rgb, b: Rgb): Rgb => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** three's ACESFilmicToneMapping (tonemapping_pars_fragment) and the sRGB output, as 8-bit codes. */
function display(lin: Rgb, exposure: number): Rgb {
  const e = exposure / 0.6;
  const [r, g, b] = [lin[0] * e, lin[1] * e, lin[2] * e];
  const i = [0.59719 * r + 0.35458 * g + 0.04823 * b, 0.076 * r + 0.90834 * g + 0.01566 * b, 0.0284 * r + 0.13383 * g + 0.83777 * b];
  const f = i.map((v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081));
  const o = [
    1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2],
    -0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2],
    -0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2],
  ].map((v) => Math.min(1, Math.max(0, v)));
  const s = o.map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** 0.41666 - 0.055));
  return [Math.round(s[0] * 255), Math.round(s[1] * 255), Math.round(s[2] * 255)];
}

const maxDiff = (a: Rgb, b: readonly number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const at = (light: string) => MEASURED.find((m) => m.what.startsWith(light))!;

function displayRow(light: MeasuredLight, row: number[]) {
  const hue = codes(row, 0, 4);
  const normalUp = normalUpOf(row[3]);
  const lit = codes(row, 4, 0.5);
  const fill = treeLeafTransmit(hue, UNIT_BASE, light.skyUp, normalUp, lit);
  return {
    before: display(lit, light.exposure),
    after: display(add(lit, fill), light.exposure),
    measuredBefore: row.slice(7, 10),
    measuredAfter: row.slice(10, 13),
  };
}

describe('skylight through the leaves, against the test-host measurements', () => {
  it.each(MEASURED.filter((m) => m.term.length > 0).map((m) => [m.what, m] as const))(
    'adds the light the shader added, pixel by pixel (%s)',
    (_, light) => {
      for (const row of light.term) {
        const hue = codes(row, 0, 4);
        const normalUp = normalUpOf(row[3]);
        const lit = codes(row, 4, 1 / 8);
        const got = luma(treeLeafTransmit(hue, UNIT_BASE, light.skyUp, normalUp, lit));
        // What the GPU added: lit with the term − without, within the two 8-bit codes' rounding,
        // + 2 % for the hue and normal codes' rounding.
        const lo = luma(codes(row, 7, 1 / 8, -0.5)) - luma(codes(row, 4, 1 / 8, 0.5));
        const hi = luma(codes(row, 7, 1 / 8, 0.5)) - luma(codes(row, 4, 1 / 8, -0.5));
        expect(got, `row ${row.join(',')}`).toBeGreaterThanOrEqual(lo * 0.98);
        expect(got, `row ${row.join(',')}`).toBeLessThanOrEqual(hi * 1.02);
      }
    },
  );

  it.each(MEASURED.map((m) => [m.what, m] as const))('draws what the screen showed (%s)', (_, light) => {
    for (const row of light.display) {
      const r = displayRow(light, row);
      // The inputs reproduce the measured screen pixel with the term off…
      expect(maxDiff(r.before, r.measuredBefore), `before ${r.before} vs ${r.measuredBefore}`).toBeLessThanOrEqual(1);
      // …and with the term on: one level from the 8-bit screen, one from the 8-bit pass.
      expect(maxDiff(r.after, r.measuredAfter), `after ${r.after} vs ${r.measuredAfter}`).toBeLessThanOrEqual(2);
    }
  });

  it('lifts the near-black golden-hour avenue crowns to a deep green, not a glow', () => {
    for (const light of [at('golden hour, 8,920'), at('golden hour, 8,980')]) {
      for (const row of light.display) {
        const { before, after } = displayRow(light, row);
        // Near-black before (luminance < 15 of 255)…
        expect(luma(before)).toBeLessThan(15);
        // …dark foliage after, not a glow: 20–32 levels of luminance (the sunlit crowns around it
        // read ≈ 45–70), with the leaf colour, not grey (green well above blue).
        expect(luma(after)).toBeGreaterThan(20);
        expect(luma(after)).toBeLessThan(32);
        expect(after[1]).toBeGreaterThan(after[2] * 1.8);
      }
    }
  });

  it('keeps a noon crown the sun lights; only its darkest shade pockets fill', () => {
    // The knee (`TREE_LEAF_TRANSMIT_KNEE`): the median near crown at noon moves about 3 levels of
    // luminance (+2.4 and, re-measured in the #67 review, +3.0; the fixture's p50 pixel below moves
    // under 3). The darkest shade pockets honestly lift: the 8,920 m p10 pixel below gains +12, and
    // over every near-crown pixel the review measured mean +3.9, p10 42.8 → 51.8.
    for (const light of [at('noon, 8,920'), at('noon, 8,980')]) {
      const [p10, p50] = light.display.map((row) => displayRow(light, row));
      expect(luma(p50.after) - luma(p50.before)).toBeLessThan(3);
      expect(luma(p10.after) - luma(p10.before)).toBeGreaterThanOrEqual(0);
    }
    const p10 = displayRow(at('noon, 8,920'), at('noon, 8,920').display[0]);
    expect(luma(p10.after) - luma(p10.before)).toBeGreaterThan(8);
    // At dawn the sun lights the median crown, which keeps its colour exactly.
    const dawn = displayRow(at('dawn, 8,920'), at('dawn, 8,920').display[1]);
    expect(dawn.after).toEqual(dawn.before);
    // Its darkest pockets still fill: the p10 pixel below lifts by about 5 (over every near-crown
    // pixel, p10 8.3 → 13.4 while the mean moves only +0.8).
    const dawnP10 = displayRow(at('dawn, 8,920'), at('dawn, 8,920').display[0]);
    expect(luma(dawnP10.after) - luma(dawnP10.before)).toBeGreaterThan(3);
    // The measured pins hold the knee tighter than this; the band documents it.
    expect(TREE_LEAF_TRANSMIT_KNEE).toBeGreaterThanOrEqual(1.5);
    expect(TREE_LEAF_TRANSMIT_KNEE).toBeLessThanOrEqual(2.5);
  });

  it('fills the avenue crowns the chase camera sees side-on, not the crown tops', () => {
    for (const deciles of Object.values(AVENUE_NORMAL_UP_DECILES)) {
      // Every decile of the near crowns' normals, up to the p90 (−0.12), gets most of the term…
      for (const normalUp of deciles) expect(treeLeafTransmitWeight(normalUp)).toBeGreaterThanOrEqual(0.85);
      // …and the full-strength edge sits inside them, at about their median.
      expect(TREE_LEAF_TRANSMIT_FACING.full).toBeGreaterThanOrEqual(deciles[2]);
      expect(TREE_LEAF_TRANSMIT_FACING.full).toBeLessThanOrEqual(deciles[6]);
    }
    // The most up-facing near-crown pixel still gets over half; a crown's sunlit top none.
    expect(treeLeafTransmitWeight(AVENUE_NORMAL_UP_MAX)).toBeGreaterThan(0.5);
    expect(treeLeafTransmitWeight(0.6)).toBe(0);
  });
});

describe('the skylight term keeps up with three', () => {
  it('pins the sky source and its guards verbatim', () => {
    // World up in view space: the facing gate and the sky both come from it.
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);');
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain(
      '#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )\n      skyUp += getIBLIrradiance(upV);\n    #endif',
    );
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain(
      '#if NUM_HEMI_LIGHTS > 0\n      skyUp += getHemisphereLightIrradiance(hemisphereLights[0], upV);\n    #endif',
    );
    expect(TREE_LEAF_TRANSMIT_GLSL.match(/upV/g)).toHaveLength(4);
    // The measured fixtures take skyUp as an input, so they can't see an edit to how the
    // shader builds it (a non-zero start, an extra scale): pin the whole block.
    const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
    const { full, none } = TREE_LEAF_TRANSMIT_FACING;
    expect(TREE_LEAF_TRANSMIT_GLSL).toBe(
      [
        '',
        '  {',
        '    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);',
        '    vec3 skyUp = vec3(0.0);',
        '    #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )',
        '      skyUp += getIBLIrradiance(upV);',
        '    #endif',
        '    #if NUM_HEMI_LIGHTS > 0',
        '      skyUp += getHemisphereLightIrradiance(hemisphereLights[0], upV);',
        '    #endif',
        `    float away = 1.0 - smoothstep(${f(full)}, ${f(none)}, dot(normalize(vNormal), upV));`,
        '    vec3 leafSky = gLeafHue * skyUp * RECIPROCAL_PI * uLeafTransmit * away * vCrown;',
        `    vec3 lumaW = vec3(${TREE_LEAF_LUMA.join(', ')});`,
        `    float knee = ${f(TREE_LEAF_TRANSMIT_KNEE)} * dot(leafSky, lumaW) + 1e-6;`,
        '    gl_FragColor.rgb += leafSky * (1.0 - smoothstep(0.0, knee, dot(gl_FragColor.rgb, lumaW)));',
        '  }',
      ].join('\n'),
    );
    expect(TREE_LEAF_TRANSMIT_GLSL.match(/skyUp/g)).toHaveLength(4);
  });

  it("matches three's own chunks, so an upgrade fails here and not in the tree shader at runtime", () => {
    // Every guard is matched up to its line end: a renamed define (ENVMAP_TYPE_CUBE_UV_V2) or an
    // added condition would still contain the old name, while the tree shader's guard goes false.
    // The env irradiance: defined only with an env map, and only a PMREM (cube UV) one gives light.
    const env = THREE.ShaderChunk.envmap_physical_pars_fragment;
    expect(env.trimStart().startsWith('#ifdef USE_ENVMAP\n')).toBe(true);
    const ibl = env.slice(env.indexOf('vec3 getIBLIrradiance( const in vec3 normal ) {'), env.indexOf('vec3 getIBLRadiance('));
    expect(ibl.length).toBeGreaterThan(0);
    expect(ibl).toMatch(/#ifdef ENVMAP_TYPE_CUBE_UV\n[\s\S]*return PI \* envMapColor\.rgb \* envMapIntensity;[\s\S]*#else[\s\S]*return vec3\( 0\.0 \);/);
    // The hemisphere irradiance: declared only with at least one hemisphere light.
    const lights = THREE.ShaderChunk.lights_pars_begin;
    const hemi = lights.indexOf('vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {');
    expect(hemi).toBeGreaterThan(-1);
    const hemiGuard = lights.lastIndexOf('#if NUM_HEMI_LIGHTS > 0\n', hemi);
    expect(hemiGuard).toBeGreaterThan(-1);
    expect(lights.slice(hemiGuard, hemi)).toContain('uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];');
    // ÷π comes from three's own constant.
    expect(THREE.ShaderChunk.common).toContain('#define RECIPROCAL_PI 0.3183098861837907');
  });

  it("normalises by the working colour space's luminance (Rec. 709)", () => {
    const rec709 = THREE.ColorManagement.getLuminanceCoefficients(new THREE.Vector3()).toArray();
    expect([...TREE_LEAF_LUMA]).toEqual(rec709);
    expect(rec709).toEqual([0.2126, 0.7152, 0.0722]);
  });
});
