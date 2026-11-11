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
- Mutations: 33 entries (`mutations.py`, kept outside the repo). 31 were killed in the
  run; the two survivors (the ±180° wrap and the non-finite guard) were pinned afterwards and both
  are killed now.

## Live: Lugano–Melide 1200 m (test host EGL; every rider material magenta; before = #83 head ef4bbeb)

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
(`cc_compare.scratch.test.ts`, kept outside the repo).

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

## Probes (before vs after, interleaved, test host)

- **Grey transient** (`sideprof.py`, Lugano–Melide, 1440×900, 150 s each): chase had 0 flat windows on both builds (8,352 / 8,340 frames). sideTracking had 1 one-frame flat window before and 0 after.
- **`ride-surface-probe.py`**, Trasimeno + Santa Monica + Cuyahoga at 1 / 3 / 5 km: the per-spot numbers are identical on both builds. Cuyahoga 3 / 5 km fails on both (the I-80 viaduct, #76).
- **`owner_cam.py`** at the same spots: rider − top, camera − top, ceilPx and skyPx are identical to ~1e-9. On the Santa Monica start, rider < top − 0.3 is 0 / 0 and ceilPx > 0 is 2 / 5 frames; Cuyahoga is 9 / 9.
- **`underview.py`**, Santa Monica start, main-view depth at the wheels, ×16 interleaved:
  - Before: 3/16 runs with a sunk frame (10 frames). After: **13/16 runs (64 frames, worst 2.29 m)**, at 6–24 m.
  - Root cause: the pre-existing drawn-vs-loaded globe mismatch that **PR #84** (t_b6dbd3d2) fixes. The rider eases onto `globe.getHeight`'s deeper loaded tile (−33.7 m) while the globe draws a coarser one at −32.2 m. Which tile is drawn under the rider depends on where the camera looks, and the new aim looks ~20° less into the start's 75° bend than the old trailing bearing.
  - On the #84 trial merges (#83+#84 vs this+#84, ×10 interleaved): **1/10 runs (1 frame, 1.44 m) vs 2/10 (3 frames, worst 0.59 m)**, so no difference.
  - **Merge after #84.**
- **Start probe** (`ride-surface-probe.py`, Santa Monica start). On the stack: before 2/0 under-samples, after 0/1. On the #84 merges ×3: 0/0/0 vs 0/1/0. The one flagged sample has the rider on the mesh top (+0.02 m) at the 36 m step, and the main view's ray to the wheels meets a mesh face 3.7 m in front of them, so it is not a sink.

Data, probes and scripts: a scratch directory outside the repo. The README there covers `out/`, `compare/`, `mutations.py`, `cc_compare.scratch.test.ts`, `startcam.py` and `underview_84.sh`.

## Rework (review R1, card t_e1563c34): the look height doesn't nod with the stored profile

**What was wrong.** The look point's height was the raw route-profile difference
(`ahead.ele - sampled.ele`). Curated profiles are whole metres at irregular spacing (Valle Maggia
8.1–8.4 km reads `8204:328 8210:327 8233:326 8239:326 …`, alternating 0 % and 11–17 %), and GPX
uploads carry raw GPS altitude. So the camera bobbed as the 10–14 m look-ahead crossed each step:
38 px in 2 s on Valle Maggia at 1440×900 standard, 31 px on Lake Como at 390×844 close.

**Change.** `lib/ride/lookRise`: `chaseLookRise(route, from, to)` is the rise on the profile
smoothed by a triangle window ±120 m (`smoothedProfileEle`, exact: the second difference of the
profile's double integral, flat beyond the ends, walks only the points in the window, ~1 µs).
`CesiumWorldView` uses it for the look point (`sceneEle`, so 0 on the flat no-token globe).

**Why this source.**

- The ride's own grade (`gradientAt` 40 m + the 0.18 EMA) still nods: 12.9 px in 2 s on Valle
  Maggia and 52–168 px on the phone-track fixtures.
- The drawn ground ahead has no cheap read (a tile pick is 3–5 ms), and on Valle Maggia the drawn
  mesh under the rider swings ±20 m over canopy (`groundEle` in the probe).
- Window: worst 2 s swing of the 1 m point at 1440×900 standard (maths, 8 m/s):

  | half-window | 0 (raw) | 40 m | 80 m | 100 m | **120 m** |
  |---|---|---|---|---|---|
  | Valle Maggia 8.1–8.4 km | 38.6 | 7.0 | 2.3 | 2.0 | **1.9** |
  | phone track AR(1) σ 2 m φ 0.95, 4 seeds | 172–201 | 30–37 | 12 | 7.6–8.8 | **5.7–6.3** |
  | phone track φ 0.9 / φ 0.5 | 251 / 606 | 47 / 70 | 16 / 18 | 9.5 / 9.9 | **7.1 / 7.4** |
  | real eTrex track (around-visnjan) | 217 | 37 | 13 | 9.2 | **7.1** |
  | every photoreal route (worst) | 52 | 15 | 6.7 | 5.0 | **4.1** |

- What it costs on real terrain: a sustained grade is kept exactly; a change of grade is taken over
  ±120 m (15–30 s). Against the drawn photoreal ground the t_215ac171 probes measured, the smoothed
  rise is closer than the raw one: Lugano 1170–1250 rms 0.12 m / max 0.17 m (raw 0.27 / 0.63),
  Valle Maggia 5100–5300 rms 0.51 / max 0.81 m (raw 0.53 / 0.87).

**Live, test-host EGL, interleaved** (`nodprobe.py`, `place()` at 8 m/s; x = the placed distance).
"2 s" = worst swing of the 1 m point in any 2 s; "stretch" = max − min over the 300 m; "resid" =
max − min of live − maths prediction for that build.

| | #83 (fixed pitch) | #86 @0450dbd | **#86 rework** | **#87 + rework** |
|---|---|---|---|---|
| Valle Maggia 8100–8400, 1440 standard: 2 s / stretch | 7 / 7 | 38 / 54 | **2.0 / 23** (×2) | **2.0 / 23** (×2) |
| Lake Como 7500–7800, 390 close: 2 s / stretch | 18 / 18 | 31 / 32 (#87) | **3.0 / 12** (×2) | **3.0 / 11** (×2) |
| resid vs maths | – | 6–7 | 1.8–2.2 | 1.8–2.2 |

The nod is gone: 2–3 px in any 2 s, under #83's fixed pitch (7 / 18 px, the clearance lift).
**Valle Maggia's 23 px over the stretch is not a nod:** the descent eases from ~6.5 % to ~2 % over
those 300 m (`8093:335 … 8395:320`, flat from 8426), so the view tilts up by 23 px over 37 s, as
the maths predicts (22.6 px; a half-window of 60 or 200 m gives 22.5 / 21.4 px). The review's
≤ 12 px for the stretch can't be met while descents tip the view down.

**Static parity.**

- `riderFraming.test.ts` chase-aim pins: unchanged, green.
- Trasimeno 1730 m corner: the live 1 m point is within 0.5 px of the world rig's maths on #86 and on
  #87 merged, at both distances and viewports (the profile is level there, so the rise is 0 either
  way).
- Lugano–Melide 1200 m (`tabframe2.py`, same spot): x unchanged; y moved up 4–5 px. Photoreal minus
  world, 1 m point dy: #86 −6 / −6 / −7 / −7 px (1440 std / 390 std / 1440 close / 390 close; was
  −1 / −2 / −2 / −2); #87 merged −5 / −4 / −5 / −4. The profile drops 1.1 m at 1226–1250 m while the
  drawn photoreal mesh stays level (±0.06 m over 1170–1250), and the window spreads that drop back to
  1200 m (rise −0.12 m instead of 0). At 1230 m the raw rule was 0.63 m off the drawn ground; the
  smoothed one is never more than 0.17 m off on that stretch.

**Pins.**

- `src/lib/ride/lookRise.test.ts`: exact against brute-force quadrature (inside, across a jump,
  over and beyond the ends, h 3 / 25 / 120 m); a straight grade kept exactly; a crest taken within
  120 m + the look-ahead with no overshoot; NaN and single-point routes.
- `src/lib/chaseCamNod.test.ts`: rides Valle Maggia 8093–8395 m and a phone-track fixture
  (`buildRoute`, flat road, AR(1) σ 2 m, 8 m spacing, 1 m steps) at 8 m/s through `chaseLookRise` +
  `chaseCamTarget` + `ChaseCamSmoother`. The 1 m point's worst 2 s swing must be ≤ 10 px at 1440×900
  standard and 390×844 close (1.9 / 1.8 px and 5.9 / 5.8 px; 4.9 / 4.8 px on #87). The raw rule
  gives 38.6 / 50.3 and 173 / 207 px there.
- `chaseCam.wiring.test.ts`: the view feeds `sceneEle(chaseLookRise(r, pose.distance,
  aheadDistance))`, and `ahead.ele - sampled.ele` is gone.
- Mutations (`mutations.py`, kept outside the repo: t_215ac171's 33 + 16 new):
  **49/49 killed** on 174f8e8, in a second detached worktree. The helper going back to the raw
  difference (window 0) fails both nod tests (38.6 and 173 px); the view going back to
  `ahead.ele - sampled.ele` fails the wiring pin. On the #87 merge, 47/47 applicable (2 anchors that
  #87 rewrote are skipped) and #87's own 15/15.

Plot (before/after, live): `photoreal-chase-aim/nod-valle-maggia-como.png`. Data and scripts:
a scratch directory outside the repo.
