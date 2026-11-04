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

## The owner's laptop: 1280×648 tab at DPR 2 (rework of the review @bbe04db, D1 + D2)

Chrome's own scale factor (`--force-device-scale-factor=2` on a 2560×1600 xvfb screen, i.e. a
1280×800 CSS screen and a 1280×648 tab), not DevTools emulation: an emulated DPR hid the cropped
canvas. `LAYOUTS=laptop node scripts/v2-build-shots/pip.mjs`; composites (mockup | build)
`compare/pipwin-{corner,third,half}-1280[-night].jpg`, `compare/pip-tab-1280[-night].jpg`.

| Size | Asked → window (CSS px) | Canvas rect (buffer) | Bar scroll / client | Pause rect | Figures / labels | Clear band (top controls end → bar top) |
|---|---|---|---|---|---|---|
| S | 448×252 → 448×252 | 0,0 448×252 (672×378) | 432 / 432 | 392,189 40×40 | 30 / 12 px | 48 → 174: 126 px (50 %) |
| M | 512×288 → 512×288 | 0,0 512×288 (768×432) | 496 / 496 | 455,223 41×41 | 30.75 / 12.3 px | 49 → 208: 159 px (55 %) |
| L | 640×360 → 637×358 (Chrome's cap) | 0,0 637×358 (955×537) | 619 / 619 | 574,287 45×45 | 33.7 / 13.5 px | 54 → 270: 216 px (60 %) |

Before (@bbe04db) the same screen got 320×180 / 427×240 / 573×318 windows; the canvas kept its
buffer size as its CSS size (480×270 in the 320×180 window) and the bar needed 355 px (383 px at
1:18:05) in a 304 px bar, so Pause was cut off.

- **D1, the canvas:** r3f 9 sizes a canvas's CSS box only when it is an `HTMLCanvasElement` of the
  opener's window; the window's canvas is another window's element. `ThreeWorldView` now sizes it
  from its container (`renderers/three/canvasSize.ts`). The canvas rect equals the window at every
  size above.
- **D2, the widths:** `PIP_MIN_WIDTH` is per size (448 / 512 / 640). With the widest figures
  (1:18:05, 42.2 km, −12.5 %) the bar measures 432 / 432 at S, Pause inside it; below `xs`
  (475 px) the bar's gaps step from 6 to 4. A 1920 screen still gets 480 / 640 / 960.
  Chrome caps L at 637 px here, under the mockup's 640 px rule, so at every laptop size the next
  landmark is the pill at the top left (as `v2-pip-window.html` draws below 640 px); the mockup
  render at exactly 640 px keeps it in the bar, which is the one difference in the L composite.
- **Pinned** by the second test in `e2e/show-mode.spec.ts` (CI job `show-mode`, xvfb 2560×1600,
  `--force-device-scale-factor=2`): at every size the canvas rect is the window's
  `innerWidth`×`innerHeight`, the rider (`__veloRideDebug().riderScreen`) is above the bar, the bar's
  `scrollWidth ≤ clientWidth` with the widest figures staged, Pause is inside the window, the clear
  band is ≥ 45 % of the height and the figures are ≥ text-2xl (24 px; measured 30–34 px). Local run: S rider y 115 above bar 174, M 129 / 208, L 132 / 270; with the
  canvas fix removed the test fails (canvas 672 px wide in a 448 px window).
- Software GL (SwiftShader) on this loaded machine (load ~25) sometimes lost the window's WebGL
  context: a white window that never recovers (`isContextLost()` true, 0 frames). Chrome's GPU
  watchdog kills a GPU process whose frames take too long; `pip.mjs` now passes
  `--disable-gpu-watchdog` and checks every window shot for a drawn world (pixel variety in the
  clear band), not just the DOM. Recovery from a lost context in the app is follow-up card
  t_14ea510a.

## When Continue can't carry on (D4)

`continueLastShow` says why (`none` / `denied` / `missing` / `done`), and the chooser says it in
one sentence with choosing again as its one filled button (UI-RULES §8). No mockup draws these
states; they use the chooser's own error line (`text-destructive`, as the picker's error) and its
existing buttons. Shots: `show-continue-{denied,missing,done,files-denied}-{1440,1280,390,tv}[-night].jpg`
(`scripts/v2-build-shots/show-continue.py`: real File System Access handles from the origin-private
file system, remembered as a picked folder or files would be; for `denied` the permission answer is
stubbed to Chrome's "denied"). Measurements: `measurements-show-continue.json`.

| Viewport | Sentence (rect, size) | Filled button | Panel | Overflow / smallest text / smallest target |
|---|---|---|---|---|
| 1440 | 48,163 464×43 (one line for `done`), 14 px | Choose a folder (Choose videos for files) | 24,24 512×355, in view | none / 14 px / 40 px |
| 1280 @2 | same as 1440 | same | 24,24 512×355, in view | none / 14 px / 40 px |
| 390 @2 | 28,181 334×43, 14 px | same | 12,12 366×437, in view | none / 14 px / 40 px |
| TV | 84,286 812×76, 24.5 px | same | 42,42 896×621, in view | none / 24.5 px / 70 px |

| Reason | Sentence |
|---|---|
| denied (folder) | Chrome didn’t allow Velo to open the folder “Episodes”. Choose it again to watch. |
| denied (files) | Chrome didn’t allow Velo to open last time’s videos. Choose them again to watch. |
| missing (folder) | The folder “Episodes” has moved, or has no videos Chrome can play now. Choose a folder. |
| done | You have watched everything from last time. Choose something new. |
| none (storage unreadable at the click) | Velo can’t reopen last time’s videos on this device. Choose them again. |

Phones can't reach these states (no File System Access in phone browsers, so no Continue); the 390
shots are the desktop state at phone width.

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
