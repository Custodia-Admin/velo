# Photoreal chase camera aims like the world chase rig (card t_215ac171)

Follow-up from t_dfa07725 (PR #83). With the same rider model in both renderers, the rest of the
framing gap was the chase camera's aim. At Lugano–Melide 1200 m the photoreal 1 m point sat 3–5 px
left of the world one at "standard" and 4–6 px right at "close". The rider box's left/right edges
were 5–9 px off at close.

## What differed

- **World** (`renderers/three/chaseRig`, `cameraTarget('chase')`): the camera sits square behind
  the rider along the *drawn* heading (`lib/ride/rideHeading`: a ±12 m chord through `YawFilter`).
  It aims half the bend toward the route point `lookAheadM` ahead (14 m standard, 10 m close),
  capped at 12°, and looks at that point's height + 1 m.
- **Photoreal** (`lib/cesiumUtils.applyFollowCam`): the camera heading eased toward the bearing of
  a point 15 m ahead, and the camera trailed along that eased heading at a fixed flat-road pitch.
  The avatar was drawn at the raw route heading (±4 m chord). So in a bend the camera sat off to
  the side (the rider was seen three-quarter on), and on a climb it looked at the road as if it
  were level.

## Change

- `lib/world/cameraFraming`: `chaseAimHeading()` and `MAX_AIM_OFFSET_RAD` (half the bend toward the
  point ahead, at most 12°) are the one rule. `chaseRig.chaseAim` uses it.
- `lib/cesiumCameras`: `chaseCamTarget(heading, ahead, framing)` is the world rig's chase target in
  the rider's local east/north/up frame. `ChaseCamSmoother` eases it with the world rig's time
  constants (`CHASE_TAU_S`, and the `CAMERA_GLIDE_*` handover from another camera mode).
  `computeCameraPose('chase')` uses the same target.
- `lib/cesiumUtils.applyFollowCam(viewer, rider, ahead, dt, {heading, framing, minClearanceMeters})`:
  the camera is eased *relative to the rider*, so there is no lag that grows with speed. Easing a
  world position trails by v·τ, 3–5 m at riding speed. `liftAboveTerrain` and `minClearanceMeters`
  still lift the camera out of the ground. A lifted camera still looks at the same point.
- `lib/ride/rideHeading.stepDrawnHeading()`: the drawn heading step shared by `rideDriver` (world)
  and `CesiumWorldView`. Photoreal now draws the rider, turns its lane offset and aims its camera
  with the same filtered heading.
- `CesiumWorldView`: the point ahead is `lookAheadM` along the route (was a fixed 15 m), taken at its
  route-profile height from the drawn ground under the rider. That is also what the world's road is
  laid on, so both renderers look at the same height.
- `lib/ride/rideSim.heldRiderPose()`: the `place(m)` probe hooks of both renderers hold the same
  pose. The world hook faced the route 12 m ahead and photoreal faced the raw ±4 m chord, which
  alone made the two renderers' place() shots differ by a few pixels in bends.

## Pins

- `src/renderers/riderFraming.test.ts`: the photoreal target and the world rig's `cameraTarget`
  run on the same pose through the pinhole harness, at the four gate viewports and both distances.
  The poses are a gentle bend, a sharp corner (aim capped at 12°), an 8 % climb and a 6 % descent.
  The 1 m point and the rider box must land on the same pixels. Also pinned: eased through a corner
  frame by frame exactly as the world `CameraRig` does, a handover gliding in from the previous
  camera, the ±180° wrap of the bend, and non-finite targets ignored.
- `src/lib/followCam.test.ts`: `applyFollowCam` with real Cesium maths and a stub viewer. It frames
  bends on a climb and a descent, eases a heading change, hands back from another mode, and keeps
  the rider framed when the camera is lifted over the slope behind.
- `src/renderers/cesium/chaseCam.wiring.test.ts`: source pins on the view. They cover the drawn
  heading, `lookAheadM`, heading + framing passed to `applyFollowCam`, the filter reset on route
  change, and `place()` holding `heldRiderPose`.
- `rideHeading.test.ts` (`stepDrawnHeading`), `rideSim.test.ts` (`heldRiderPose`).
- Mutations: 33 entries (`~/.hermes/handoffs/velo/t_215ac171/mutations.py`). 31 were killed in the
  run; the two survivors (the ±180° wrap and the non-finite guard) were pinned afterwards and both
  are killed now.

## Live: Lugano–Melide 1200 m (cat-bed EGL; every rider material magenta; before = #83 head ef4bbeb)

Photoreal 1 m point minus the world one (dx, dy), and the photoreal box minus the world GLB's
projected vertex box (left, top, right, bottom), CSS px:

| | standard before | standard after | close before | close after |
|---|---|---|---|---|
| 1440×900 | (−4, −1) −3.7, −1.6, −3.0, −3.1 | **(0, −1)** −0.7, −1.6, −2.0, −3.1 | (+5, −2) +6.4, −2.9, +6.9, −4.4 | **(0, −2)** −0.6, −2.9, −1.1, −4.4 |
| 1280×648 @2 | (−3, −1) −2.1, −1.9, −2.1, −1.6 | **(0, −1)** −0.1, −1.9, −1.1, −1.6 | (+4, −2) +5.0, −2.4, +5.5, −3.2 | **(0, −2)** −1.0, −2.4, −0.5, −3.2 |
| TV | (−5, −2) −3.4, −3.3, −4.0, −4.1 | **(0, −2)** −1.4, −3.3, −1.0, −4.1 | (+6, −3) +8.3, −2.9, +9.1, −4.9 | **(−1, −3)** −1.7, −2.9, −0.9, −4.9 |
| 390×844 @3 | (−4, −2) −3.0, −1.6, −1.8, −2.5 | **(0, −2)** −0.7, −1.6, −0.8, −2.5 | (+5, −2) +6.9, −1.5, +7.0, −3.1 | **(0, −2)** −1.4, −2.9, 0.0, −3.1 |

- The x offset is gone: the 1 m point is within 1 px in x everywhere, and the left/right edges are
  within 1.7 px (they were 5–9 px off at close).
- What is left in y (1–3 px on the 1 m point, top −1.6…−3.3, bottom −1.6…−4.9) is identical before
  and after, so it doesn't come from the camera. The world places the rider on its baked
  heightfield and photoreal on the drawn Google mesh/globe, and this card touches neither. "Within
  ~2 px on the 1 m point" holds everywhere except TV close, which is 3 px in y. The box bottom at
  close misses the card's ~3 px at 1440 (−4.4) and TV (−4.9) and at 1280 too (−3.2); all three are
  unchanged from before. At TV the vertex box runs behind the HUD strip: both renderers' pixel boxes
  stop at y 922.
- Ride HUD untouched (no UI change).

Composites: `photoreal-chase-aim/tab-{close,standard}-*.jpg` (world | before | after).
Green box = world GLB vertices projected, yellow = magenta pixels, white tick = 1 m point.

## Live: a sharp corner and a climb (photoreal-only routes)

The world bbox has no curated non-world route, so these compare the live photoreal frame with the
world rig's maths (`chaseRig.cameraTarget`) for the same held pose
(`~/.hermes/handoffs/velo/t_215ac171/cc_compare.scratch.test.ts`).

| spot | | world maths 1 m pt | after (live) | before (live) |
|---|---|---|---|---|
| Trasimeno 1730 m, 17° bend, flat | standard 1440 | 642.2, 567.5 | 642, 567 | 720, 567 (**+78 px**) |
| | standard 390 | 122.0, 532.2 | 122, 532 | 195, 531 (**+73 px**) |
| | close 1440 | 799.9, 556.9 | 800, 557 | 720, 556 (**−80 px**) |
| | close 390 | 269.9, 522.2 | 270, 522 | 195, 522 (**−75 px**) |
| Valle Maggia 5205 m, −9° bend, 9 % climb | standard 1440 | 761.9, 614.9 | 762, 615 | 720, 567 (**−42, −48 px**) |
| | standard 390 | 234.3, 576.6 | 235, 577 | 195, 531 (**−39, −46 px**) |
| | close 1440 | 714.8, 607.1 | 715, 607 | 720, 556 (**−51 px in y**) |
| | close 390 | 190.1, 569.4 | 190, 569 | 195, 522 (**−47 px in y**) |

After: within 0.7 px of the world rig everywhere. Before, the old rule trailed the bearing of the
15 m point, so photoreal kept the rider dead centre in corners, seen three-quarter on, and looked at
a climb as if it were flat.

**Climb at "close": the rear wheel reaches under the HUD strip in both renderers.** This is the
world rig's look rule (point ahead + 1 m), which this card carries over to photoreal. On the 9 %
climb at close, the rear tyre contact projects 21 px (1440) and 45 px (390) under the strip. Before,
photoreal's flat pitch kept it 43 / 14 px clear. At 390 close the wheel reaches the strip from about
2.5 % grade; at standard distance it stays clear (57 / 28 px on the same climb). Follow-up card
**t_54dc80e6** changes the shared rule for both renderers.

Composites: `photoreal-chase-aim/cc-*.jpg` (before | after). Green X = the world rig's maths.

## Probes (before vs after, interleaved, cat-bed)

- **Grey transient** (`sideprof.py`, Lugano–Melide, 1440×900, 150 s each): chase had 0 flat windows on both builds (8,352 / 8,340 frames). sideTracking had 1 one-frame flat window before and 0 after.
- **`ride-surface-probe.py`**, Trasimeno + Santa Monica + Cuyahoga at 1 / 3 / 5 km: the per-spot numbers are identical on both builds. Cuyahoga 3 / 5 km fails on both (the I-80 viaduct, #76).
- **`owner_cam.py`** at the same spots: rider − top, camera − top, ceilPx and skyPx are identical to ~1e-9. On the Santa Monica start, rider < top − 0.3 is 0 / 0 and ceilPx > 0 is 2 / 5 frames; Cuyahoga is 9 / 9.
- **`underview.py`**, Santa Monica start, main-view depth at the wheels, ×16 interleaved:
  - Before: 3/16 runs with a sunk frame (10 frames). After: **13/16 runs (64 frames, worst 2.29 m)**, at 6–24 m.
  - Root cause: the pre-existing drawn-vs-loaded globe mismatch that **PR #84** (t_b6dbd3d2) fixes. The rider eases onto `globe.getHeight`'s deeper loaded tile (−33.7 m) while the globe draws a coarser one at −32.2 m. Which tile is drawn under the rider depends on where the camera looks, and the new aim looks ~20° less into the start's 75° bend than the old trailing bearing.
  - On the #84 trial merges (#83+#84 vs this+#84, ×10 interleaved): **1/10 runs (1 frame, 1.44 m) vs 2/10 (3 frames, worst 0.59 m)**, so no difference.
  - **Merge after #84.**
- **Start probe** (`ride-surface-probe.py`, Santa Monica start). On the stack: before 2/0 under-samples, after 0/1. On the #84 merges ×3: 0/0/0 vs 0/1/0. The one flagged sample has the rider on the mesh top (+0.02 m) at the 36 m step, and the main view's ray to the wheels meets a mesh face 3.7 m in front of them, so it is not a sink.

Data, probes and scripts: `~/.hermes/handoffs/velo/t_215ac171/`. The README there covers `out/`, `compare/`, `mutations.py`, `cc_compare.scratch.test.ts`, `startcam.py` and `underview_84.sh`.
