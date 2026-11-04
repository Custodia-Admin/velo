# P2.3 build evidence: show & journey mode v2

Approved mockups: `docs/design/mockups/v2-show.html` (P2.4, show mode; its corner's
"Watch another tab" lands here), and the P2.3 additions `v2-pip.html` (the floating window over
another tab at S/M/L, and the Velo tab meanwhile) and `v2-pip-window.html` (the window's own
document). Mockup renders: `../mockup/pip*.jpg`, `../mockup/pipwin-*.jpg`.

Build shots: `scripts/v2-build-shots/pip.mjs` (headed Chromium 153 under xvfb, raw DevTools
protocol; software GL), Assisi valley at 6.1 km / 18:05, golden light, chase camera, day and
night themes. Composites (mockup | build): `compare/pipwin-{corner,third,half}[-night].jpg`,
`compare/pip-tab-{1440,390,tv}[-night].jpg`.

## The floating window (measured in the build, getComputedStyle / rects)

| Size | Window (CSS px) | Root font | Figures | Labels | JourneyBar rect | Next landmark |
|---|---|---|---|---|---|---|
| S (corner) | 480×270 | 16 px | 30 px | 12 px | 8,192 464×70 (mockup: 8,192 464×70) | pill, top left |
| M (third) | 640×360 | 18 px | 33.75 px | 13.5 px | 9,272 622×79 | in the bar |
| L (half) | 923×518 (asked 960×540; Chrome caps the size) | 21.5 px | 40.4 px | 16.2 px | 11,413 901×94 | in the bar |

Figures stay ≥ 28 px at every size (blueprint: readable at 2 m). The rider sits in the clear band
between the top controls and the bar at every size (lens shift by half the bar's height,
`applyHudLensShift`); at S the rider's box is ~231–249 × 107–163 with the bar at y = 192.

## The Velo tab while the ride floats

One centred message ("Your ride is in the floating window" / "It keeps recording while you watch
something else."), one primary action ("Bring the ride back"), the show strip bottom right and
Close top right, as in the mockup at 1440, 390 and TV (1920×1080, `data-layout=tv`: heading 44 px,
strip figures 64 px, button 84 px tall). The chooser panel does not show while the ride floats.

## Deliberate deviations

- **Data in the shots:** the build's next place is "Bastia Umbra in 3.8 km" and grade 0.0 % at
  6.1 km (the route's real data); the mockup's still says "Rivotorto in 900 m", 0.4 %.
- **Landmark pins** draw in the world in the window as in the full ride view (the mockup's painted
  still has none).
- **Phones (390):** no browser on a phone has Document Picture-in-Picture, so the floating state is
  unreachable there; the 390 shot is the same tab state at phone width for completeness. The
  corner Close is sm+ in show mode (as shipped in P2.4); phones end show mode from the ride tools.
- **Corner without Document PiP:** "Watch another tab" only exists where the browser can float the
  ride (capability first). Elsewhere the corner's first slot keeps P2.4's camera choice.
