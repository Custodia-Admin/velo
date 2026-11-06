# Chase "close" on the flat: the rear wheel clears the ride HUD strip at every gate viewport (card t_4c664b25)

Follow-up from t_54dc80e6 (PR #87). At "close" on the flat the chase camera looked at the route
point 10 m ahead + 1 m, like the other distances. That left the rear wheel tight against the ride
HUD strip on the shorter-strip windows. In t_215ac171's Lugano shots, the GLB wheel's back edge sat
3.9 px behind the strip on a TV (1920×1080) and cleared it by 1.8 px at 1280×648. On PR #87's
runtime the same spot measures −0.5 px (TV) and +3.9 px (1280), because PR #87 dropped a small
tip-up from the ground rising ahead. In a bend that caps the aim at 12°, the maths puts the TV
wheel 4.7 px behind the strip.

## Change (shared framing, both renderers)

- `ChaseFraming` gains `aimM`: on the flat, how far over the route point `lookAheadM` ahead the
  camera looks. It is 0.85 m at "close" and stays 1 m (`AIM_HEIGHT_M`) for standard, far and
  overview.
- `cameraFraming.chaseLookHeight` uses it for the flat, the descent and the climb rule's flat-road
  pitch. `cesiumCameras.chasePitchRad` uses it too. The world rig (`chaseAim`) and photoreal
  (`chaseCamTarget`) both go through `chaseLookHeight`, so they move together.
- **Effect:** the view tips down 0.43°, and the whole frame slides up 5–11 px. The camera position,
  rider size, the rider's place against the horizon, the half-bend aim and the climb rule are
  unchanged.
- No HUD or UI change.

Why a lower aim and not the other two candidates (pinhole maths, TV, to the same wheel clearance):

| candidate | wheel up | horizon | rider's helmet to horizon | other behaviour |
|---|---|---|---|---|
| **aim 0.85 m (chosen)** | +11.2 px | +9.7 px (moves with the frame) | unchanged (49.8 px) | none |
| camera 1.83 m (was 1.9) | +10.9 px | −4.5 px (moves the other way) | 49.7 → 36.1 px: the rider covers more of the road ahead | none |
| look-ahead 8 m (was 10) | +10.8 px | +9.3 px | unchanged | aims into corners and reads the climb over a shorter stretch |

## Pins

- `src/renderers/riderFraming.test.ts` (both renderers' cameras, pinhole harness, GLB vertices):
  - At the 4 gate viewports, the GLB rear wheel's lowest pixel is at least 5 px over
    `HUD_STRIP_TOP`. This holds on the flat, straight and in ±10–48° bends, for both cameras.
    Straight-road clearance is 10–50 px. The capped bend is the tightest case: TV +6.6 px,
    1280 +8.2 px.
  - The 1 m aim drew the TV wheel behind the strip. The new aim only tilts the view: same camera
    position, and the wheel, 1 m point and horizon all move up 8–12 px together (within 2 px). The
    rider is drawn the same size (within 2 px).
  - The climb and descent pins now read `framing.aimM`. The climb rule still keeps the (new)
    flat-road framing at every grade.
- `src/renderers/three/chaseRig.test.ts`: the close look point on a climb or descent uses `aimM`.
- Mutations: `~/.hermes/handoffs/velo/t_4c664b25/mutations.py`, 10 entries, 10 killed. They cover:
  close back at 1 m; 0.9 m; 0.7 m; a lower camera instead; a shorter look-ahead instead; the flat
  look or the climb pitch ignoring `aimM`; standard aiming lower; and either renderer looking 1 m
  over the point on the flat.

## Live (cat-bed EGL; before = PR #87 runtime, after = this card; Lugano–Melide 1,200 m, "close")

Wheel bottom over the top of the HUD strip under the rider, CSS px. Each rider was shot painted
magenta, then again with the HUD hidden, so the box reaches the wheels behind the strip. The world
rows also give the GLB vertices projected through the live camera.

| renderer | 1440×900 | 1280×648 @2 | TV 1920×1080 | 390×844 @3 |
|---|---|---|---|---|
| world: GLB vertices | +40.4 → **+49.7** | +3.9 → **+10.6** | −0.5 → **+10.7** | +12.3 → **+21.0** |
| world: magenta, HUD hidden | +42 → **+51** | +5 → **+11.5** | +1 → **+13** | +13.7 → **+22.3** |
| photoreal: magenta, HUD hidden | +42 → **+51** | +5 → **+10.5** | 0 → **+12** | +12.7 → **+21** |

The live GLB numbers match the pinhole maths within 0.1 px: before 40.5 / 3.9 / −0.5 / 12.3, after
49.8 / 10.6 / 10.7 / 21.1. The 1 m point (`riderScreen`) moves up 8 / 6 / 10 / 7–8 px in both
renderers. The rider's height is unchanged (photoreal `riderHeightPx` 287 → 286 at 1440, 345 → 344
on TV).

Controls (same before/after builds):
- **Climbs keep the new flat framing**, so the wheel gains about the same 9–11 px there as on the
  flat:
  - Locarno–Brissago 2,800 m (8.8 %, world GLB vertices): TV +17.1 → +28.3, 390 +26.1 → +34.8.
  - Valle Maggia 5,205 m (9.2 %, photoreal, HUD hidden): TV +13 → +24, 390 +22.3 → +31.7.
- **"Standard" is unchanged.** Lugano 1,200 m world: the 1 m point and the wheels are identical at
  1440 (+114) and 390 (+81).

What it costs: at "close" the picture sits about 1 % of the window height higher. The view shows a
little more road under the rider and a little less sky. Nothing else in the frame changes.

Composites in `flat-close-framing/`:
- `n-*`: the rider's own colours, before | after, full frames.
- `m-*`: magenta measurement crops. Cyan = strip top; yellow and red = rider box and wheel bottom
  with the HUD hidden; white = the 1 m point.

## Left as is

- **Crest transient** (from PR #87): just past a climb's top the rear wheel dips by the bike's pitch
  for a moment (~10 px at 12 % at 390 close). This card doesn't change the rule behind it and didn't
  re-measure it. The extra flat clearance (+6–11 px) also raises where that dip starts.

Data, scripts and the full composites are in `~/.hermes/handoffs/velo/t_4c664b25/`:
`out/*/tabframe.json`, `compare/`, `tabframe3.py`, `queue.sh`, `compose.py`, `mutations.py`.
