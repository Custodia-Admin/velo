/**
 * The world canvas's clock across a paused frame loop.
 *
 * r3f restarts its clock at 0 whenever the canvas's frame loop changes mode
 * (`setFrameloop`): the world view stops its loop while the finish screen
 * covers it and starts it again for Ride again. Scene parts keep deadlines on
 * `clock.elapsedTime` (landmark pins re-pick every 0.5 s, the perf readout
 * publishes on an interval). After a restart those deadlines would sit as far
 * ahead as the ride had run, and the pins would freeze for that long.
 *
 * `keepClockSteady` runs first in every frame: when the clock reads less than
 * the last frame drawn, it carries on from there by this frame's delta. The
 * time stays monotonic and the paused stretch is left out.
 */

export interface ElapsedClock {
  elapsedTime: number;
}

export interface ClockMemo {
  /** elapsedTime of the last frame drawn. */
  last: number;
}

export function createClockMemo(): ClockMemo {
  return { last: 0 };
}

export function keepClockSteady(clock: ElapsedClock, memo: ClockMemo, delta: number): void {
  if (clock.elapsedTime < memo.last) clock.elapsedTime = memo.last + Math.max(0, delta);
  memo.last = clock.elapsedTime;
}
