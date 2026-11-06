# Photoreal rider: the same rider as the world renderer (card t_dfa07725)

Follow-up from the PR #74 review (@1bd0bb1). The review measured the photoreal rider 19–40 px
"lower and 4–9 % larger" than the world rider at the same 1 m point, and the wheels of both close
to the ride strip at the "close" camera distance.

## What was really different

**Placement was never off.** Both renderers put the model's origin (ground contact, midway between
the wheels) on the ground point that the chase camera and `__veloRideDebug().riderScreen` use:

- world: `riderRig.placeRider` → `Rider.tsx` root position;
- photoreal: `avatar.update` → `smoothedEle`, the same value as `groundEle()`, which the camera
  and the 1 m point use.

Projecting each renderer's model through its own chase camera reproduces the live boxes to within
about 2 px (`src/renderers/riderFraming.test.ts`).

**The review's world box stopped at the rims.** The GLB's tyres, bib shorts, socks and metal parts
are fixed materials. The avatar colours (the magenta paint) never reach them, so the world box ended
about 0.27 m above the ground. Painting every rider material (`tabframe2.py`, `PAINT_ALL=1`) moves
the world box bottom 37–40 px down, for example 658 → 698 at 1440×900. That matches the photoreal
tyres to within 1–2 px. The world wheels' real clearance over the ride strip is therefore the same
as photoreal's. At "close" on TV the world tyres reach 4 px *behind* the strip: their projected
vertices end at y 927 and the strip starts at 923.

**The photoreal rider was smaller.** The Cesium avatar was a smaller rig than the GLB rider:

| | old avatar | GLB rider (world) |
|---|---|---|
| helmet top | 1.36 m | 1.645 m |
| saddle | 0.71 m | 0.975 m |
| hips | 0.82 m | 1.05 m |
| thigh / knee→pedal | 0.43 / 0.43 m | 0.46 / 0.53 m (shin + ankle) |

Wheels, wheelbase and widths were already the same. Only the box top differed: it sat 19–56 px under
the world rider's.

## Change

- `src/lib/avatar.ts`: the rider and bike landmarks now come from the GLB rig
  (`scripts/gen-rider-glb.mjs`):
  - bottom bracket, crank 0.1725 m, saddle, seat and head tubes, stem and bars;
  - hips 1.05 m and the leg lengths;
  - torso axis pelvis → neck, shoulders and elbows;
  - head and helmet (shell centre 1.545 m, so the road shell's top is 1.645 m).

  Helmet details, kit bands and dots, the bottle and the battery are placed relative to those
  landmarks. `AVATAR_RIG` names the values the avatar shares with the GLB's `RIG`.
- `avatarSurfacePoints()` gives the avatar's silhouette as drawn: box corners, cylinder rims and an
  ellipsoid grid per part. Only tests call it.
- `scripts/gen-rider-glb.mjs`: `build()` is now exported for the test. The regenerated GLB is
  byte-identical.

## Pins (`src/renderers/riderFraming.test.ts`)

- Each renderer's own model goes through its own chase camera: three/chaseRig `cameraTarget` for
  the GLB, lib/cesiumCameras `computeCameraPose` for the avatar. The test covers the four gate
  viewports at standard and close distance, in all three postures and over a pedal stroke. **Every
  box edge must be within 2 px.** The largest difference now is 1.0 px; before it was 55 px at the
  top.
- Same ground, same height: tyres at 0 and helmet tops within 1 cm.
- `AVATAR_RIG` equals the GLB `RIG` for wheels, wheelbase, bottom bracket, crank, hips and thigh.
  The avatar's shin equals the GLB's shin plus its ankle height.
- The legs reach the pedals all the way round, so the knee IK never clamps.
- Mutations: 15/15 killed (`~/.hermes/handoffs/velo/t_dfa07725/mutations.py <detached worktree>`).

## Live (cat-bed EGL, token prod dists, Lugano–Melide 1200 m, noon clear, every rider material magenta)

Box edges in CSS px (left, top, right, bottom). The world reference is the GLB's vertices projected
through the live camera; its magenta box misses 1–3 px of the lit helmet crown.

**Standard distance, photoreal minus world, absolute:**

| viewport | before | after |
|---|---|---|
| 1440×900 | −2.7, **+28.4**, −3.0, −3.1 | −3.7, −1.6, −3.0, −3.1 |
| 1280×648 @2 | −1.1, **+20.6**, −2.1, −1.6 | −2.1, −1.9, −2.1, −1.6 |
| TV 1920×1080 | −2.4, **+34.7**, −4.0, −3.1 | −3.4, −3.3, −4.0, −4.1 |
| 390×844 @3 | −1.7, **+26.8**, −3.1, −2.5 | −3.0, −1.6, −3.1, −2.5 |

**Close distance, photoreal minus world, absolute:**

| viewport | before | after |
|---|---|---|
| 1440×900 | +9.4, **+44.1**, +6.9, −4.5 | +6.4, −2.9, +6.9, −4.5 |
| 1280×648 @2 | +6.0, **+32.1**, +5.5, −3.2 | +5.0, −2.4, +5.5, −3.2 |
| TV 1920×1080 | +10.3, **+53.1**, +9.1, −5.0 | +8.3, −2.9, +9.1, −5.0 * |
| 390×844 @3 | +7.9, **+41.8**, +7.0, −3.1 | +5.6, −2.9, +7.0, −3.1 |

\* At TV close the photoreal tyres are hidden behind the strip too (visible bottom 922, strip at
923), so the bottom edge reads short.

**Relative to each renderer's own 1 m point**, after the change every edge is within 2.5 px at both
distances. Before, the top was off by 21.6–56.1 px.

**What is left is the cameras, not the rider.** At this spot the two chase cameras put the 1 m point
3–6 px apart in x and 1–3 px apart in y, both before and after:

- standard: x −3…−5, y −1…−2;
- close: x +4…+6, y −2…−3.

The photoreal chase camera trails along the eased bearing to the route point ahead. The world chase
rig trails along the filtered heading and aims half the bend toward a point 14 m (or 10 m) ahead,
at that point's height + 1 m. That difference is the x offset at "close" (5–9 px). Follow-up card:
photoreal chase camera aims like the world chase rig.

The HUD is unchanged: the collapsed ride HUD covers 4.8 / 7.5 / 9.2 / 10.9 % of the viewport
(1440 / 1280 / TV / 390).

## Composites

world | photoreal before | photoreal after, from the same spot. Each composite has crops round
the rider with the boxes, the strip and the 1 m point, plus the full frames below:

- `photoreal-rider/rider-standard-{1440x900_1,1280x648_2,tv,390x844_3}.jpg`
- `photoreal-rider/rider-close-{1440x900_1,1280x648_2,tv,390x844_3}.jpg`
- `photoreal-rider/rider-colours-1280-close.jpg`: side-on and chase, close, in the rider's own
  colours.

## Probes (before = 1bd0bb1, after = this branch, interleaved on cat-bed)

The ground placement code is untouched. These runs check that a taller avatar changes nothing about where the rider stands or what the camera sees.

- **`owner_cam.py`** held at 1000 / 3000 / 5000 m on Trasimeno, Santa Monica and Cuyahoga. rider − top, camera − top, ceilPx and skyPx are **identical on both builds to 1e-9**. From the start, the "rider < top − 0.3" count is 3 → 0 on Santa Monica and 10 → 9 on Cuyahoga (LOD noise).
- **`ride-surface-probe.py`**, Santa Monica start, ×4 each: before 0/0/0/0 samples under a drawn surface, after 0/1/0/0. On the full 3-route run: before 1/3 pass (Santa Monica had 1 sample under), after 2/3. Cuyahoga 3000 / 5000 m fails with the same numbers on both builds (the I-80 viaduct, PR #76).
- **`underview.py`**, Santa Monica ×6 each (main-view depth on frames the overhead pick flags): before 8 frames in 4/6 runs (worst 2.26 m, plus one 2,277 m pickPosition artifact), after 11 frames in 3/6 runs (worst 1.43 m). This is the early-start under-sample class that main and #74 show too (t_b6dbd3d2).
