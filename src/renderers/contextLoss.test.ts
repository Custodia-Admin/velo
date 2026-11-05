/**
 * The renderer-neutral context-loss listener (renderers/contextLoss.ts,
 * cards t_14ea510a and t_771036a6): both world views put it on their canvas.
 */
import { describe, expect, it, vi } from 'vitest';

import { watchContextLoss } from './contextLoss';

const lose = (canvas: EventTarget) => {
  const e = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
};
const restore = (canvas: EventTarget) => canvas.dispatchEvent(new Event('webglcontextrestored'));

describe('watchContextLoss', () => {
  it('cancels the loss (so the browser may restore it) and reports it; reports the restore', () => {
    const canvas = new EventTarget();
    const on = { lost: vi.fn(), restored: vi.fn() };
    watchContextLoss(canvas, on);
    const e = lose(canvas);
    expect(e.defaultPrevented).toBe(true);
    expect(on.lost).toHaveBeenCalledTimes(1);
    expect(on.restored).not.toHaveBeenCalled();
    restore(canvas);
    expect(on.restored).toHaveBeenCalledTimes(1);
  });

  it('says nothing once stopped: the loss a renderer forces on a canvas it tears down is not reported', () => {
    const canvas = new EventTarget();
    const on = { lost: vi.fn(), restored: vi.fn() };
    const stop = watchContextLoss(canvas, on);
    stop();
    expect(lose(canvas).defaultPrevented).toBe(false);
    restore(canvas);
    expect(on.lost).not.toHaveBeenCalled();
    expect(on.restored).not.toHaveBeenCalled();
  });
});
