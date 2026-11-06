/**
 * The ride view drives the globe gate every frame (a source pin: the view is
 * a 1,500-line Cesium component with no test harness). What each line buys:
 * - the gate reads what the rider stands on (avatar.ground), so the globe
 *   hides only over a loaded mesh road;
 * - it runs before the avatar samples the ground, so the rider measures the
 *   ground as it will be drawn this frame (never a frame under a globe that
 *   just came back);
 * - its answer is what the scene draws; the painted road (ground
 *   classifications that paint walls and trees over the mesh) follows its
 *   own answer, never the globe's (the globe also stands in under crowns and
 *   decks, where the road would run up the piers);
 * - the start watch is told when the mesh is the ground (a hidden globe stops
 *   refining, which would hold every start to the cap);
 * - a missing rider or a new route puts the globe back.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(resolve(__dirname, 'CesiumWorldView.tsx'), 'utf-8');

describe('CesiumWorldView drives the ground gate', () => {
  it('feeds it what the rider stands on and the tileset visibility, then draws what it says', () => {
    expect(SRC).toContain(
      'const groundDraw = groundGateRef.current.update(nowMs, photorealShown, avatarRef.current.ground());',
    );
    expect(SRC).toContain('const globeShown = groundDraw.globe;');
    expect(SRC).toContain('if (viewer.scene.globe.show !== globeShown) viewer.scene.globe.show = globeShown;');
    expect(SRC.split('groundGateRef.current.update(').length - 1).toBe(1);
  });

  it('decides before the avatar samples this frame', () => {
    const gate = SRC.indexOf('groundGateRef.current.update(');
    const avatar = SRC.indexOf('avatarRef.current.update(');
    expect(gate).toBeGreaterThan(0);
    expect(avatar).toBeGreaterThan(gate);
  });

  it('draws the painted road only where the gate says the globe is the ground (over the mesh it paints walls and trees)', () => {
    expect(SRC).toContain('const road = roadEntityRef.current;');
    expect(SRC).toContain('if (road && road.entity.show !== groundDraw.road) {');
    expect(SRC).toContain('road.entity.show = groundDraw.road;');
    expect(SRC).toContain('road.centerline.show = groundDraw.road;');
    expect(SRC).toContain('for (const stripe of roadEdgeStripesRef.current?.entities ?? []) stripe.show = groundDraw.road;');
    // Nothing of the painted road follows the globe itself.
    expect(SRC).not.toMatch(/(entity|centerline|stripe)\.show = globeShown;/);
    expect(SRC).not.toMatch(/(entity|centerline|stripe)\.show !== globeShown/);
  });

  it('tells the start watch when the mesh is the ground', () => {
    expect(SRC).toContain('startGroundRef.current.update(sampled.lon, sampled.lat, drawn, groundEle, nowMs, !globeShown);');
  });

  it('puts the globe back with no rider and on a new route', () => {
    const resets = SRC.split('groundGateRef.current.reset();').length - 1;
    expect(resets).toBe(2);
    expect(SRC).toMatch(/if \(!r \|\| !avatarRef\.current\) \{\s*groundGateRef\.current\.reset\(\);\s*viewer\.scene\.globe\.show = true;/);
    expect(SRC).toMatch(/groundGateRef\.current\.reset\(\);\s*if \(!viewer\.isDestroyed\(\)\) viewer\.scene\.globe\.show = true;\s*\n\s*if \(!route\) return;/);
  });
});
