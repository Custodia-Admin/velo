/**
 * The Ride page's handlebar listener: the menu layer (lib/tv/handlebarNav)
 * first, then the P2.5 ride map. One press reaches exactly one of them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RideButton } from '@/lib/controllers/rideProtocol';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (fn: () => void | (() => void)) => {
    fn();
  },
}));

let listener: ((b: RideButton) => void) | null = null;
vi.mock('@/lib/controllers/rideController', () => ({
  onControllerButton: (fn: (b: RideButton) => void) => {
    listener = fn;
    return () => (listener = null);
  },
  buzzRideController: vi.fn(),
}));

const runControllerAction = vi.fn();
vi.mock('@/lib/controllers/controllerActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/controllers/controllerActions')>()),
  runControllerAction: (...a: unknown[]) => runControllerAction(...a),
}));

const runNavIntent = vi.fn();
vi.mock('@/lib/tv/runNavIntent', () => ({ runNavIntent: (...a: unknown[]) => runNavIntent(...a) }));

import { useRideControllerActions } from './useRideControllerActions';
import { useRideStore } from '@/stores/rideStore';
import { useShowStore } from '@/stores/showStore';

function press(b: RideButton) {
  if (!listener) throw new Error('no handlebar listener');
  listener(b);
}

describe('useRideControllerActions: menu layer, then the ride map', () => {
  beforeEach(() => {
    runControllerAction.mockClear();
    runNavIntent.mockClear();
    useShowStore.setState({ active: false });
    useRideControllerActions();
  });

  it('riding: A pauses through the ride map; Y opens the details through the menu layer', () => {
    useRideStore.setState({ rideState: 'running' });
    press('a');
    expect(runControllerAction).toHaveBeenCalledWith('pauseResume', expect.anything());
    expect(runNavIntent).not.toHaveBeenCalled();
    press('y');
    expect(runNavIntent).toHaveBeenCalledWith('details', { inRide: true });
    expect(runControllerAction).toHaveBeenCalledTimes(1);
  });

  it('paused: A presses the ringed button (menu), shifting still shifts', () => {
    useRideStore.setState({ rideState: 'paused' });
    press('a');
    expect(runNavIntent).toHaveBeenCalledWith('select', { inRide: true });
    expect(runControllerAction).not.toHaveBeenCalled();
    press('shiftUpL');
    expect(runControllerAction).toHaveBeenCalledWith('gearHarder', expect.anything());
  });

  it('finished: the D-pad moves on the finish page, nothing else acts', () => {
    useRideStore.setState({ rideState: 'finished' });
    press('shiftUpL');
    press('hoodL');
    press('y');
    expect(runControllerAction).not.toHaveBeenCalled();
    expect(runNavIntent).not.toHaveBeenCalled();
    press('right');
    expect(runNavIntent).toHaveBeenCalledWith('right', { inRide: true });
  });

  it('show mode: B is the auto camera, not Back', () => {
    useRideStore.setState({ rideState: 'running' });
    useShowStore.setState({ active: true });
    press('b');
    expect(runControllerAction).toHaveBeenCalledWith('showAutoCamera', expect.anything());
    expect(runNavIntent).not.toHaveBeenCalled();
  });
});
