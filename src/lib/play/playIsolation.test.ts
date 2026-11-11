/**
 * Blueprint §P3.2: no gameplay element blocks the FTMS loop. The play layer
 * (postcards, ghosts, the couple ghost) runs in the renderer's frame and
 * only reads the ride: it never imports the trainer, controller or ride-loop
 * modules, and never writes the ride store. A source scan, so a later edit
 * that wires gameplay into the trainer path fails here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PLAY_FILES = [
  ...readdirSync('src/lib/play')
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'recordedRideFixture.ts')
    .map((f) => join('src/lib/play', f)),
  'src/lib/ghosts.ts',
  'src/renderers/three/CoupleGhost.tsx',
  'src/renderers/three/coupleGhostDriver.ts',
  'src/renderers/three/PlayLayer.tsx',
  'src/renderers/three/Ghosts.tsx',
  'src/stores/playStore.ts',
  'src/stores/coupleGhostStore.ts',
];

const TRAINER_IMPORTS = [/lib\/ftms/, /lib\/controllers\//, /hooks\/useRideLoop/, /lib\/virtualGears/, /lib\/rideDrive\b/];
const RIDE_WRITES = [/useRideStore\.setState/, /useRideStore\.getState\(\)\.(?!route\b|distance\b|elapsedMs\b|speed\b|power\b|cadence\b|grade\b|rideState\b|paceBots\b)\w+\s*\(/, /\bsetSimulationParams\b/, /\bsetTargetPower\b/];

describe('the play layer stays off the trainer path', () => {
  it('covers the files it should', () => {
    expect(PLAY_FILES).toEqual(expect.arrayContaining(['src/lib/play/threePlayLayer.ts', 'src/lib/play/coupleGhost.ts', 'src/lib/play/ghostReplay.ts']));
  });

  for (const file of PLAY_FILES) {
    it(`${file}: no trainer, controller or ride-loop import, no ride-store write`, () => {
      const src = readFileSync(file, 'utf8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const re of TRAINER_IMPORTS) expect(imports.filter((i) => re.test(i)), `${file} imports ${re}`).toEqual([]);
      for (const re of RIDE_WRITES) expect(src.match(re), `${file} writes the ride: ${re}`).toBeNull();
    });
  }
});
