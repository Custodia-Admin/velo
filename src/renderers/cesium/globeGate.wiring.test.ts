/**
 * The ride view drives the globe gate every frame (a source pin: the view is
 * a 1,500-line Cesium component with no test harness). What each line buys:
 * - the gate reads the rider's mesh status, so the globe hides only over a
 *   loaded mesh road;
 * - it runs before the avatar samples the ground, so the rider measures the
 *   ground as it will be drawn this frame (never a frame under a globe that
 *   just came back);
 * - its answer is what the scene draws;
 * - the start watch is told when the mesh is the ground (a hidden globe stops
 *   refining, which would hold every start to the cap);
 * - a missing rider or a new route puts the globe back.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(resolve(__dirname, 'CesiumWorldView.tsx'), 'utf-8');

describe('CesiumWorldView drives the globe gate', () => {
  it('feeds it the rider mesh status and the tileset visibility, then draws what it says', () => {
    expect(SRC).toContain(
      'const globeShown = globeGateRef.current.update(nowMs, photorealShown, avatarRef.current.meshGround());',
    );
    expect(SRC).toContain('if (viewer.scene.globe.show !== globeShown) viewer.scene.globe.show = globeShown;');
  });

  it('decides before the avatar samples this frame', () => {
    const gate = SRC.indexOf('globeGateRef.current.update(');
    const avatar = SRC.indexOf('avatarRef.current.update(');
    expect(gate).toBeGreaterThan(0);
    expect(avatar).toBeGreaterThan(gate);
  });

  it('tells the start watch when the mesh is the ground', () => {
    expect(SRC).toContain('startGroundRef.current.update(sampled.lon, sampled.lat, drawn, groundEle, nowMs, !globeShown);');
  });

  it('puts the globe back with no rider and on a new route', () => {
    const resets = SRC.split('globeGateRef.current.reset();').length - 1;
    expect(resets).toBe(2);
    expect(SRC).toMatch(/if \(!r \|\| !avatarRef\.current\) \{\s*globeGateRef\.current\.reset\(\);\s*viewer\.scene\.globe\.show = true;/);
    expect(SRC).toMatch(/globeGateRef\.current\.reset\(\);\s*if \(!viewer\.isDestroyed\(\)\) viewer\.scene\.globe\.show = true;\s*\n\s*if \(!route\) return;/);
  });
});
