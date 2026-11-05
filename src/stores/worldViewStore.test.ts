/**
 * The world view's WebGL context slot (stores/worldViewStore, card
 * t_14ea510a): which reports count, when the canvas key moves (= <Canvas>
 * remounts), and that a view going away takes its "stopped" state with it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { canvasKeyFor, lostIn, reloadIn, restoredIn, selectWorldStopped, useWorldViewStore } from './worldViewStore';

const store = () => useWorldViewStore.getState();

afterEach(() => {
  useWorldViewStore.setState({ view: null });
});

describe('worldViewStore transitions (pure)', () => {
  const view = { id: 3, canvasKey: 0, stopped: false };

  it('a loss on the current canvas of the owning view stops it', () => {
    expect(lostIn(view, 3, 0)).toEqual({ id: 3, canvasKey: 0, stopped: true });
  });

  it('a loss from another view or an old canvas is ignored', () => {
    expect(lostIn(view, 2, 0)).toBe(view);
    expect(lostIn({ ...view, canvasKey: 1 }, 3, 0)).toEqual({ ...view, canvasKey: 1 });
    expect(lostIn(null, 3, 0)).toBeNull();
  });

  it('reload remounts a stopped view on the next key, and leaves a live one alone', () => {
    expect(reloadIn({ ...view, stopped: true })).toEqual({ id: 3, canvasKey: 1, stopped: false });
    expect(reloadIn(view)).toBe(view);
    expect(reloadIn(null)).toBeNull();
  });

  it('a restore remounts only the canvas that was lost', () => {
    const stopped = { ...view, stopped: true };
    expect(restoredIn(stopped, 3, 0)).toEqual({ id: 3, canvasKey: 1, stopped: false });
    expect(restoredIn(stopped, 3, 1)).toBe(stopped);
    expect(restoredIn(stopped, 4, 0)).toBe(stopped);
    expect(restoredIn(view, 3, 0)).toBe(view);
  });
});

describe('worldViewStore', () => {
  it('lost -> stopped (the chip shows) -> restored -> the canvas key moves on (remount) and the chip goes', () => {
    const id = store().attach();
    expect(canvasKeyFor(store(), id)).toBe(0);
    expect(selectWorldStopped(store())).toBe(false);

    store().contextLost(id, 0);
    expect(selectWorldStopped(store())).toBe(true);
    expect(canvasKeyFor(store(), id)).toBe(0);

    store().contextRestored(id, 0);
    expect(selectWorldStopped(store())).toBe(false);
    expect(canvasKeyFor(store(), id)).toBe(1);
  });

  it('lost -> the rider taps -> remount; a late restore of the old canvas changes nothing', () => {
    const id = store().attach();
    store().contextLost(id, 0);
    store().reload();
    expect(canvasKeyFor(store(), id)).toBe(1);
    expect(selectWorldStopped(store())).toBe(false);

    store().contextRestored(id, 0);
    store().contextLost(id, 0); // r3f forcing the old canvas's loss as it tears it down
    expect(canvasKeyFor(store(), id)).toBe(1);
    expect(selectWorldStopped(store())).toBe(false);

    // The new canvas can be lost and recovered again.
    store().contextLost(id, 1);
    expect(selectWorldStopped(store())).toBe(true);
    store().reload();
    expect(canvasKeyFor(store(), id)).toBe(2);
  });

  it('a tap with nothing stopped does nothing (no needless rebuild)', () => {
    const id = store().attach();
    store().reload();
    store().reload();
    expect(canvasKeyFor(store(), id)).toBe(0);
  });

  it('the floating window closes: the next view owns the slot, the old one\'s late loss and detach are ignored', () => {
    const pip = store().attach();
    const tab = store().attach();
    expect(tab).not.toBe(pip);
    store().contextLost(pip, 0); // the window's document going away
    expect(selectWorldStopped(store())).toBe(false);
    store().detach(pip);
    expect(store().view?.id).toBe(tab);
    expect(canvasKeyFor(store(), pip)).toBe(0);
  });

  it('leaving the ride clears a stopped view (no stale chip on the next ride)', () => {
    const id = store().attach();
    store().contextLost(id, 0);
    store().detach(id);
    expect(store().view).toBeNull();
    expect(selectWorldStopped(store())).toBe(false);
    const next = store().attach();
    expect(canvasKeyFor(store(), next)).toBe(0);
    expect(selectWorldStopped(store())).toBe(false);
  });
});
