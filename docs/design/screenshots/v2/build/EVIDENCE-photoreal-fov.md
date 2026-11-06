# Photoreal chase framing matches the world renderer (card t_a67fb090)

Follow-up from `EVIDENCE-pip-photoreal.md` (PR #49). Both renderers place the chase camera the
same way (`lib/world/cameraFraming` `CHASE_FRAMING`), and both said "fov 60", but the two angles
were different:

- **three.js** draws a **vertical** field of 60°.
- **Cesium** (`PerspectiveFrustum` default, never set) draws 60° across the canvas's **longer
  side**. In landscape that is the width: ~36° vertical at 16:9, and 32.6° on the owner's
  1280×648 tab.

So photoreal was zoomed in **1.78× at 16:9 and 1.98× at 1280×648** compared with the world
renderer, from the same camera position.

The effect was the same everywhere:

- **Tab:** the rider was drawn larger and lower. The bottom of the magenta rider box sat at
  **99–100 % of the tab height**, behind the ride HUD at 1440, 1280 and TV.
- **Floating window:** the wheels sat **36–46 px behind the bar** at S/M/L on every screen.
- **Wide window (760×240):** the wheels were 95 px behind the bar.

## Decision

Photoreal now draws the world renderer's vertical field: **60°, one constant for both renderers**
(`lib/world/cameraFraming` `RIDE_FOV_Y_DEG`).

I chose this over keeping the closer photoreal look and only re-framing the window. The close
look was never a choice:

- It was a unit mismatch, and it broke the tab as well (the wheels sat at the tab's bottom edge).
- The "Camera distance" setting already gives the closer view (`close`: 4.5 m back), and it now
  looks the same in both renderers.

### How the fov is set

- `renderers/cesium/hudLensCrop` owns `camera.frustum.fov`. `cesiumFov(fovY, aspect)` converts
  the vertical field to Cesium's longer side.
- It re-sets the fov in `scene.preUpdate` whenever the canvas changes shape (window drag, tab ↔
  floating window, the taller cropped canvas).
- It does nothing in three cases:
  - while WebXR owns the projection (`ownsFrustum: () => viewer.useDefaultRenderLoop`);
  - for an orthographic frustum;
  - in portrait, where Cesium's fov is already vertical (390 is unchanged).

## Measured (Lugano–Melide 1200 m, token build, cat-bed, `pip-photoreal.mjs` + `fovperf.py`)

### Tab

The "1 m point" is the projected point 1 m above the route. The magenta box is the rider and bike
painted magenta and found in the pixels.

| viewport | world: 1 m point y / box | photoreal before | **photoreal after** |
|---|---|---|---|
| 1440×813 (tab) | 514 / 448–603 (h 155) | 593 / 522–803 (h 281), **box bottom 98.8 %** | **512 / 472–630 (h 158)** |
| 1280×648 @2 | 409 / 357–483 (h 126) | 490 / 427–648 (h 221), **box bottom 99.9 %** | **408 / 376–503 (h 127)** |
| TV 1920×993 | 627 / 547–738 (h 191) | 746 / 651–992 (h 341), **box bottom 99.9 %** | **625 / 577–770 (h 193)** |
| 390×844 @2 (portrait) | 533 | 531 (h 172) | 531 (h 172): unchanged, the control |

After the change, the photoreal 1 m point is within 2 px of the world renderer's, and the rider's
height is within 2 %.

Photoreal's rider is drawn ~25 px lower than the world rider for the same 1 m point. The offset
was there before this change too. Scaled by the old 1.78× zoom it is the same: before, the box top
sat 71 px above the 1 m point at 1440, which is 40 px at 1×, the same as after. So it does not
depend on the fov. The cause is where each renderer puts the model relative to the projected
1 m point. That is a separate question from this card.

### Floating window: wheels vs bar top (CSS px, + = above the bar)

Wheels are measured with the bar hidden. The world renderer's gap is given for comparison.

| screen | size | before | **after** | world |
|---|---|---|---|---|
| 1280×648 @2 | S 448×252 | −36 | **+18** | +27 |
| | M 512×288 | −36.9 | **+25.6** | +36.1 |
| | L 637×358 | −39.1 | **+37.4** | +52.9 |
| | wide 760×240 (drag) | −94.6 | **+6.9** | +14.9 |
| | tiny 320×180 (drag) | −36.5 | **+2.5** | +8 |
| | portrait 300×420 (drag) | +55.5 | +55.5 | +68 |
| 1440×900 | S / M / L | −36 / −36.9 / −40.6 | **+18 / +26.1 / +46.4** | +26 / +35.1 / +62.4 |
| TV 1920×1080 | S / M / L | −36 / −39.7 / −46 | **+22 / +38.3 / +65** | +35 / +49.3 / +83 |

The window field is 60° (`__veloRideDebug().fovYDeg`) at every size. The crop and lens shift are
unchanged from PR #49.

### Photoreal cost (same spot, same governor level 7 on cat-bed)

The wider field selects fewer and coarser tiles, because the screen-space error per pixel grows.

| | tiles selected | draw commands | network |
|---|---|---|---|
| TV, before → after (1200 / 2400 / 3600 m) | 167 / 162 / 180 → **130 / 148 / 144** | 346 / 327 / 342 → **303 / 320 / 302** | 68 / 74 / 78 → **46 / 52 / 56 MB** |
| 1280×648 @2 | 108 / 109 / 113 → **96 / 101 / 96** | 283 / 273 / 271 → **270 / 262 / 251** | 49 / 53 / 57 → **35 / 38 / 41 MB** |
| 390 (unchanged field) | 88 / 115 / 102 → 88 / 115 / 102 | same | same |

There is a cost: the close ground is visibly coarser, because there is more of it in the frame at
a lower level of detail.

I am not reporting frame rate. cat-bed swings between 19 and 60 fps on identical back-to-back
runs (tv-before 1200 m: 38, 57 and 19 fps), so it can't tell before from after.

### Probes that must still pass

All of these ran on the production dists on cat-bed:

- **before** = main;
- **after** = the field only;
- **after2** = this PR (the field plus the ground-sampler fix below).

**The fix, `lib/avatar` `createGroundSampler`.** The wider field changed one thing at the Santa
Monica start: the photoreal tile under the rider now arrives earlier, at ~36 m instead of ~75 m.
That first tile is coarse. It reads 11 m under the drawn globe, yet it counts as the road, and from
then on the throttled sampler only re-reads the mesh every 250 ms. When the street tile landed
4.2 m over the globe, the rider stayed on the globe under the street for 3–6 frames (144–290 ms),
with the camera under the road.

The sampler now re-reads the mesh every frame while the rider stands on the drawn globe more than
`GLOBE_OVER_MESH_M` (0.25 m) over the mesh reading. It already did this when there was no reading
at all. This lasts until the mesh is the ground or the globe gate hides the globe (750 ms). Pinned
in `src/lib/drawnGround.test.ts`.

**Santa Monica start, per frame** (`underframes.py`: every drawn frame, the rider's ground vs the
top of the drawn ground at the rider):

| | handoff to the street tile | frames with the rider under it |
|---|---|---|
| before ×6 | at 73–75 m | **1 frame** (34–41 ms) |
| after ×4 | at 35–37 m | **3–6 frames (144–290 ms)** |
| after2 ×4 | at 35–37 m | **1 frame** (43–51 ms) |

**`ride-surface-probe.py`, Santa Monica start** (21 / 21 / 19 runs, interleaved, plus the full
runs):

- At the handoff, runs with a sample under a drawn surface: before 0, after **3**, after2 **0**.
- In the first 25 m, runs with a sample 0.5–1.5 m under: before 2, after 2, after2 5.
  - In these samples the camera is above the surface (`ceilPx` 0, underside 0). The app's CPU
    mesh pick misses a tile that the main view already draws.
  - It happens on main too. The difference between after and after2 is sampling noise: the two
    builds run the same code in the first 25 m.
  - The per-frame overhead pick suggests longer windows early on with the 60° field. But in the
    first seconds it picks its own coarse level of detail (worst readings 26 m), so I don't rely
    on it there.
  - Follow-up card: t_b6dbd3d2.

**`ride-surface-probe.py`, full run** (Trasimeno, Santa Monica, Cuyahoga, 1280×648 @2):

- All three builds pass 2/3 routes.
- Cuyahoga 3000 m (under the viaduct) and 5000 m fail on main as well. The rider's held height
  under the viaduct differs from run to run (170.9 / 173.1 / 160.9 m).
- In every build the start rides off at 1.6–2.4 s.

**`owner_cam.py`** (same routes):

- Rider and camera clearance against the top surface is identical in all three builds at 1000,
  3000 and 5000 m on Trasimeno and Santa Monica.
- `ceilPx` (surface above the camera in the frame's top strip) rises where trees overhang the road:
  Trasimeno 1000 m 11 → 20, Santa Monica 1000 m 0 → 9. The wider field shows more of the canopy
  above the road. `cam-top` is unchanged, so this is not the camera inside geometry.

**Grey transient** (`sideprof.py`, 1440, chase, 180 s, ×2 each), flat frames:

- before: 0, then 1;
- after: 0 and 0;
- after2: 0 and 0.

**Tab framing with the fix** (1280×648 @2): 1 m point 408, rider 132 px, field 60°. This is the
same as after.

## Pins

- `src/renderers/cesium/hudLensCrop.test.ts`:
  - the fov maths against three's projection;
  - photoreal and the world renderer project the rider to the same pixel;
  - the field is re-set on a shape change (and on a few px of drag);
  - orthographic and WebXR frustums are left alone;
  - the debug probe's reading;
  - the CesiumWorldView wiring, including PR #49 review N1.
- `src/lib/drawnGround.test.ts`:
  - a finer tile landing over the globe is stood on the next frame;
  - the throttle holds while the mesh is the ground, or while the globe is within
    `GLOBE_OVER_MESH_M` of it.
- Mutation run: **34/34 killed** (`~/.hermes/handoffs/velo/t_a67fb090/mutations.py`).
- `e2e/show-mode.spec.ts`, test 3 (PR #49 review N2):
  - a token-free photoreal ride floated to S at DPR 2;
  - asserts the crop (`top: −2·shift`), `lensShiftPx`, and a 60° field in the tab and the window.
- `scripts/v2-build-shots/pip-photoreal.mjs`:
  - exits 1 when the wheels are behind the bar;
  - `RENDERER=world` gives the side-by-side.

## Shots (`photoreal-fov/`)

Each sheet shows world renderer | photoreal before | photoreal after.

Window sheets mark the bar top in cyan and the wheels (measured with the bar hidden) in magenta.

| Sheet | Shows |
|---|---|
| `fov-tab-1280-1200.jpg` | Tab, the owner's laptop (1280×648 @2) |
| `fov-tab-1440-2400.jpg` | Tab, 1440×900 |
| `fov-tab-tv-2400.jpg` | Tab, TV 1920×1080 |
| `fov-tab-390-1200.jpg` | Tab, 390×844 @2: portrait, unchanged (the control) |
| `fov-tab-close-1280-1200.jpg`, `fov-tab-close-tv-1200.jpg` | Tab with the "close" camera distance |
| `fov-window-laptop-{corner,third,half}.jpg` | Floating window S / M / L on the 1280×648 @2 screen |
| `fov-window-laptop-wide.jpg`, `fov-window-laptop-tiny.jpg` | Drag-resized windows, 760×240 and 320×180 |
| `fov-window-1440-corner.jpg` | Floating window S, 1440 screen |
| `fov-window-tv-corner.jpg`, `fov-window-tv-half.jpg` | Floating window S and L, TV screen |

About the "close" sheets: close is 4.5 m back. On the laptop it draws the rider 207 px tall,
which is 79 % of the old standard look's 261 px, and the wheels stay in view. This is the
closer look, by choice, in both renderers.

## Seen in the shots, not changed here

- **Route markers.** The red dot left of the road is the route's FINISH marker, and the white dots
  with "2 km"/"3 km" are kilometre markers. `lib/routeVisuals` draws them with
  `disableDepthTestDistance: ∞`, so they show through the hill. They were already there; the
  wider field now has them in view.
- **Close ground.** The photoreal ground close to the camera is coarse, as the cost table shows.
