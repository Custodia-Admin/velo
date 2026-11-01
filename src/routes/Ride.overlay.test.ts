/**
 * Regression: the gesture-legend overlay swallowed every top-bar click.
 *
 * The ride view stacks full-screen overlay layers above the Cesium canvas.
 * A wrapper that spans `absolute inset-0` must stay click-through
 * (`pointer-events-none`); only the genuinely interactive children (the "?"
 * chip, the open legend dialog) may opt back in with `pointer-events-auto`.
 * On 31 Oct 2026 the inner gesture-legend wrapper was `pointer-events-auto`,
 * which intercepted Exit / theme / audio / ghosts / invite / settings clicks
 * (hotfix e27214a). These source-level assertions fail if that flips back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const rideSrc = readFileSync(join(ROOT, 'src/routes/Ride.tsx'), 'utf8');
const legendSrc = readFileSync(join(ROOT, 'src/components/ride/GestureLegend.tsx'), 'utf8');
const hudSrc = readFileSync(join(ROOT, 'src/components/velo/RideHud.tsx'), 'utf8');

describe('Ride overlay layers stay click-through', () => {
  it('every absolute inset-0 overlay wrapper in Ride.tsx is pointer-events-none', () => {
    const wrappers = rideSrc.match(/className="[^"]*absolute inset-0[^"]*"/g) ?? [];
    expect(wrappers.length).toBeGreaterThan(0);
    for (const w of wrappers) {
      expect(w, `overlay wrapper must be click-through: ${w}`).toContain('pointer-events-none');
    }
  });

  it('the gesture-legend inner wrapper is click-through (the e27214a culprit)', () => {
    expect(rideSrc).toContain('className="relative w-full h-full pointer-events-none"');
    expect(rideSrc).not.toContain('className="relative w-full h-full pointer-events-auto"');
  });

  it('GestureLegend opts its interactive parts back in', () => {
    // The "?" chip and the open legend dialog take pointer events; nothing else.
    const auto = legendSrc.match(/pointer-events-auto/g) ?? [];
    expect(auto.length).toBeGreaterThanOrEqual(2);
  });

  it('the v2 HUD row and the bottom column span the screen but stay click-through', () => {
    // RideHud's top row is hud-inset-x wide; only its panels and buttons opt in.
    expect(hudSrc).toContain("'pointer-events-none absolute hud-inset-t hud-inset-x");
    expect(hudSrc.match(/pointer-events-auto/g)?.length).toBeGreaterThanOrEqual(2);
    expect(rideSrc).toContain('absolute hud-inset-b hud-inset-x z-20 flex flex-col items-stretch gap-2 pointer-events-none');
  });
});

describe('Ride HUD keeps blur off the live canvas (PR #16)', () => {
  it('the ride root keeps hud-flat and nothing in Ride.tsx asks for a backdrop blur', () => {
    expect(rideSrc).toContain('className="hud-flat ');
    expect(rideSrc).not.toMatch(/className="[^"]*backdrop-/);
    expect(rideSrc).not.toContain('backdropFilter');
  });

  it('the paused veil is a plain scrim', () => {
    expect(rideSrc).toContain('bg-scrim/20 pointer-events-none');
  });
});
