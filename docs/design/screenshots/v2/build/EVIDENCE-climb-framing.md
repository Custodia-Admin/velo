# Chase camera on a climb keeps the rider's wheels clear of the ride HUD (card t_54dc80e6)

Follow-up from t_215ac171 (PR #86). Both renderers' chase cameras looked at the route point
`lookAheadM` ahead + 1 m. On a climb that point rises, so the view tipped up the slope and the
rider dropped down the frame. At "close" on Valle Maggia's 9 % (5,205 m) the rear tyre was drawn
21 px (1440×900) and 45 px (390×844) under the ride HUD strip. At 390 close it reached the strip
from about 2.5 % grade.

## Change (one shared rule, both renderers)

- `lib/world/cameraFraming.chaseLookHeight(framing, riseM)`: how high the chase camera looks, above
  the rider's ground, when the route point ahead is `riseM` above or below it.
  - **On the flat and downhill:** unchanged. It looks at the point ahead + 1 m, so on a descent the
    camera tips down and more road shows ahead.
  - **On a climb:** the camera keeps its flat-road pitch. It tips down only by as much as the bike's
    pitch up the slope lowers the rear axle (`REAR_AXLE_M`, the GLB rig's `rearAxle`). The rear wheel
    is then drawn where it is on the flat at every grade, distance and window shape. The slope is the
    grade to the point ahead.
- The world rig (`three/chaseRig.chaseAim`) and photoreal (`cesiumCameras.chaseCamTarget`) both use
  it. The half-bend aim (≤12°), the camera position and the smoothing are unchanged.
- No HUD or UI change.

## Pins

- `src/renderers/riderFraming.test.ts` (both renderers, pinhole harness):
  - the card's case: a 12 % climb at close on 390×844 draws the rear tyre contact over the strip,
    and the old rule drew it more than 40 px under;
  - at the 4 gate viewports × close/standard × 3–15 %, straight and in ±20–30° bends, the rear tyre
    contact stays over the measured strip top, and the GLB rear wheel's lowest pixel is drawn where
    it is on the flat (−2…+0.5 px);
  - the look point never rises over the rider's + 1 m on a climb, and the rule is continuous at 0;
  - downhill still tips down: the 1 m point rides more than 10 px higher on a 6 % descent;
  - `REAR_AXLE_M` equals the GLB `RIG.rearAxle`.
- `src/renderers/three/chaseRig.test.ts`: a real `THREE.PerspectiveCamera` through `CameraRig` on a
  12 % climb at close on 390×844. The rear tyre is drawn over the strip, within 8 px of the flat.
- `src/renderers/three/cornerFraming.test.ts`: the real per-frame code (`driveRideFrame` →
  `cameraTarget` → `CameraRig`) on the Lugano world, up Locarno–Brissago's 6–7 % climb
  (2,740–2,850 m) at close and standard. The rear tyre stays over the strip at all 4 gate viewports
  on every frame.
- Mutations: 15 entries (`~/.hermes/handoffs/velo/t_54dc80e6/mutations.py`), 15 killed.

## Live (cat-bed EGL; before = PR #86 runtime, after = this card; distance "close")

Wheel bottom over the top of the HUD strip under the rider, CSS px. Each rider was shot painted
magenta, then shot again with the HUD hidden so the box reaches the wheels behind the strip. World
rows also give the GLB's vertices projected through the live camera.

| spot | renderer | 1440×900 | 1280×648 @2 | TV | 390×844 @3 |
|---|---|---|---|---|---|
| Valle Maggia 5,205 m, 9.2 % | photoreal | −20 → **+52** | −39 → **+12** | −72 → **+13** | −44 → **+22** |
| Locarno–Brissago 2,800 m, 8.8 % | world (GLB vertices) | −12 → **+55** | −34 → **+15** | −64 → **+17** | −37 → **+26** |
| Assisi valley 4,500 m (Perugia world) | world (GLB vertices) | +11 → **+39** | | | −15 → **+11** |

Controls:
- Lugano–Melide 1,200 m (flat): photoreal identical before and after (1 m point and wheels). World
  1 m point 2–3 px higher. The world's drawn ground rises slightly there, and any climb now keeps
  the flat framing.
- Locarno–Brissago 4,190 m (−2.9 % descent, world): identical before and after.

At the default "standard" distance the rider no longer drops on the climb either. The wheels were
already clear there. The 1 m point moves up:
- Valle Maggia at 1440: y 615 → 561;
- Valle Maggia at 390: 577 → 526;
- Locarno–Brissago at 1440: 624 → 560;
- Locarno–Brissago at 390: 585 → 525.

What it costs: on a climb the frame no longer tips up toward the hillside, so the whole picture sits
about as it does on the flat. Rider and road are higher, and there is less sky above the hill.

Composites in `climb-framing/`:
- `n-*`: the rider's own colours, before | after, at close and standard.
- `m-*`: magenta measurement crops. Cyan = strip top; yellow and red = rider box and wheel bottom
  with the HUD hidden.

## Left as is

- **"Close" on the flat at TV** is tight in both renderers, and this card doesn't change it.
  t_215ac171's Lugano tab shot had the GLB rear wheel's back edge ~4 px behind the strip (vertex box
  bottom 926.9 against 923), and 1280×648 close clears by only +1.8 px. Follow-up card filed.
- **Crests:** the slope is the grade to the point ahead (10 m at close). Just over the top of a
  climb the bike is still pitched while the road ahead is level, so for a moment the rear wheel
  drops by the bike's pitch (~10 px at 12 % at 390). At the foot of a climb it is the reverse: the
  rider rides a little higher.

Data, scripts and the full composites are in `~/.hermes/handoffs/velo/t_54dc80e6/`:
`out/*/tabframe.json`, `compare/`, `tabframe3.py`, `queue.sh`, `compose.py`, `summ.py`,
`mutations.py`, and `spots-maths.json` (the rule's maths at each spot).
