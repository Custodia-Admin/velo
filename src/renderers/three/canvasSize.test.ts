/**
 * The world canvas fills its container in the floating ride window
 * (canvasSize.ts): r3f 9 leaves the CSS size of a canvas from another window
 * at its buffer size, so at DPR 2 the window showed a cropped world with the
 * rider under the bar (review of PR #36 @bbe04db, D1). The end-to-end pin is
 * e2e/show-mode.spec.ts at device scale factor 2.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillContainer } from './canvasSize';

describe('fillContainer', () => {
  it('sizes the canvas from its container, whatever its buffer size', () => {
    const canvas = { width: 960, height: 540, style: { width: '', height: '' } };
    fillContainer(canvas);
    expect(canvas.style).toEqual({ width: '100%', height: '100%' });
  });

  it('the world view applies it to every canvas it creates', () => {
    const src = readFileSync(resolve(__dirname, 'ThreeWorldView.tsx'), 'utf8');
    expect(src).toMatch(/onCreated=\{\(\{ gl \}\) => fillContainer\(gl\.domElement\)\}/);
  });
});
