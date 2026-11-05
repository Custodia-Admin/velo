/**
 * The floating window's bar keeps its figures at text-3xl at every window
 * size (`Figure size="large"`): 30 px at the corner size, the ≥ 28 px the
 * blueprint asks for from the sofa. `major` would drop to text-2xl in a
 * window narrower than sm, which every corner window is. Called as a plain
 * function; the elements it returns are read, not rendered.
 *
 * Review of PR #36 @bbe04db (optional P11): shrinking the figures left every
 * test green.
 */
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Pause } from 'lucide-react';

vi.mock('./ShowRideStrip', () => ({ useShowRideNumbers: () => null }));

const { JourneyBar, JourneyLandmark } = await import('./JourneyBar');
const { Figure } = await import('./Figure');
const { NextLandmark } = await import('./NextLandmark');

type El = ReactElement<Record<string, unknown>>;
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (isValidElement(node)) {
    out.push(node as El);
    for (const v of Object.values((node as El).props)) elements(v, out);
  }
  return out;
}

const numbers = {
  time: '1:18:05',
  distanceValue: '42.2',
  distanceUnit: 'km',
  distanceAria: 'Distance: 42.2 km',
  gradeText: '-12.5',
  next: { name: 'Rivotorto', distance: 'in 900 m' },
  progress: 0.4,
  action: { label: 'Pause ride', icon: Pause, run: () => undefined },
};

describe('JourneyBar', () => {
  it('time, distance and grade at text-3xl in every window (size large), and one Pause', () => {
    const tree = JourneyBar({ numbers });
    const figs = elements(tree).filter((e) => e.type === Figure);
    expect(figs.map((f) => f.props.label)).toEqual(['Time', 'Distance', 'Grade']);
    expect(figs.map((f) => f.props.size)).toEqual(['large', 'large', 'large']);
    const buttons = elements(tree).filter((e) => e.props['aria-label'] === 'Pause ride');
    expect(buttons).toHaveLength(1);
  });

  it('the next landmark: in the bar from sm, its own pill below sm', () => {
    const inBar = elements(JourneyBar({ numbers })).find((e) => e.type === NextLandmark);
    expect(inBar?.props.next).toBe(numbers.next);
    expect(String(inBar?.props.className)).toMatch(/\bhidden\b.*\bsm:flex\b/);
    const pill = JourneyLandmark({ numbers }) as El | null;
    expect(pill?.type).toBe(NextLandmark);
    expect(pill?.props.next).toBe(numbers.next);
    expect(String(pill?.props.className)).toMatch(/\bsm:hidden\b/);
    expect(JourneyLandmark({ numbers: { ...numbers, next: null } })).toBeNull();
  });

  // Review of PR #36 @61defbb (F2): "Bastia Umbra in 6…" in the 640 px window.
  it('bar and pill both shorten the place name only (NextLandmark), never the distance', () => {
    const lines = [...elements(JourneyBar({ numbers })), JourneyLandmark({ numbers }) as El].filter((e) => e.type === NextLandmark);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.props.testId).toBe('journey-next');
      // No truncation around the line itself: NextLandmark decides what shortens.
      expect(String(line.props.className)).not.toMatch(/\btruncate\b|text-ellipsis/);
    }
  });
});
