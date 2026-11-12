/**
 * The world canvas's clock across a paused frame loop (frameClock.ts).
 *
 * The world view stops r3f's frame loop while the finish screen covers it
 * and starts it again for Ride again. r3f's `setFrameloop` restarts the
 * clock at 0 each time; scene parts keep deadlines on `clock.elapsedTime`
 * (landmark pins re-pick every 0.5 s), which would then sit as far ahead as
 * the ride had run. These tests drive a real THREE.Clock the way r3f 9 does
 * (one getDelta per frame, then the useFrame subscribers; setFrameloop =
 * stop, zero, start) and check the time the scene reads.
 */
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClockMemo, keepClockSteady } from './frameClock';

let nowMs = 0;
beforeEach(() => {
  nowMs = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined); // THREE.Clock is deprecated (r183); r3f 9 still uses it
});
afterEach(() => vi.restoreAllMocks());

/** r3f 9's store.setFrameloop (events-*.esm.js). */
function setFrameloop(clock: THREE.Clock, frameloop: 'always' | 'never') {
  clock.stop();
  clock.elapsedTime = 0;
  if (frameloop !== 'never') {
    clock.start();
    clock.elapsedTime = 0;
  }
}

/** One r3f frame `ms` after the last: getDelta, then the subscribers (SteadyClock first). Returns the time the scene reads. */
function frame(clock: THREE.Clock, memo: ReturnType<typeof createClockMemo> | null, ms: number): number {
  nowMs += ms;
  const delta = clock.getDelta();
  if (memo) keepClockSteady(clock, memo, delta);
  return clock.elapsedTime;
}

describe('the world canvas clock across a paused frame loop', () => {
  it('carries on from the last frame drawn after the loop is paused and started again; the paused time is left out', () => {
    const clock = new THREE.Clock();
    const memo = createClockMemo();
    setFrameloop(clock, 'always');
    let t = 0;
    for (let k = 0; k < 600; k++) t = frame(clock, memo, 100); // a 60 s ride
    expect(t).toBeCloseTo(60, 6);
    // Finish: the loop stops. Two minutes on the finish page, no frames.
    setFrameloop(clock, 'never');
    nowMs += 120_000;
    // Ride again: the loop starts (r3f restarts the clock at 0).
    setFrameloop(clock, 'always');
    const after = [frame(clock, memo, 100), frame(clock, memo, 100), frame(clock, memo, 100)];
    expect(after[0]).toBeCloseTo(60.1, 6);
    expect(after[1]).toBeCloseTo(60.2, 6);
    expect(after[2]).toBeCloseTo(60.3, 6);
  });

  it("without it, r3f's restart puts the scene's 0.5 s deadlines a whole ride ahead (why it exists)", () => {
    const clock = new THREE.Clock();
    setFrameloop(clock, 'always');
    for (let k = 0; k < 600; k++) frame(clock, null, 100);
    const nextPick = clock.elapsedTime + 0.5; // Landmarks: re-pick pins in 0.5 s
    setFrameloop(clock, 'never');
    setFrameloop(clock, 'always');
    let picksIn10s = 0;
    for (let k = 0; k < 100; k++) if (frame(clock, null, 100) >= nextPick) picksIn10s++;
    expect(picksIn10s).toBe(0);
    // With the steady clock the deadline comes up within the first 0.5 s.
    const steady = new THREE.Clock();
    const memo = createClockMemo();
    setFrameloop(steady, 'always');
    for (let k = 0; k < 600; k++) frame(steady, memo, 100);
    const due = steady.elapsedTime + 0.5;
    setFrameloop(steady, 'never');
    setFrameloop(steady, 'always');
    const times = Array.from({ length: 10 }, () => frame(steady, memo, 100));
    expect(times.findIndex((t) => t >= due)).toBe(4);
  });

  it('leaves a clock that runs forward alone, frame for frame', () => {
    const clock = new THREE.Clock();
    const memo = createClockMemo();
    setFrameloop(clock, 'always');
    let sumMs = 0;
    for (let k = 0; k < 50; k++) {
      const ms = 8 + (k % 7) * 5;
      sumMs += ms;
      expect(frame(clock, memo, ms)).toBeCloseTo(sumMs / 1000, 9);
    }
    expect(memo.last).toBe(clock.elapsedTime);
  });

  it('never runs backwards, even on a frame with no time (delta 0)', () => {
    const clock = { elapsedTime: 0 };
    const memo = createClockMemo();
    clock.elapsedTime = 42;
    keepClockSteady(clock, memo, 0.016);
    expect(clock.elapsedTime).toBe(42);
    clock.elapsedTime = 0; // restarted
    keepClockSteady(clock, memo, 0);
    expect(clock.elapsedTime).toBe(42);
    clock.elapsedTime = 0.01;
    keepClockSteady(clock, memo, -1); // a nonsense delta does not take it back
    expect(clock.elapsedTime).toBe(42);
  });
});
