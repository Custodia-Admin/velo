# P2.4 build evidence: warm-atlas identity

Built from the approved mockups `docs/design/mockups/v2-{home,ride-hud,devices,show,finish}.html`
and the token delta in `docs/design/v2-identity.md`. The mockups are ground truth; every
deliberate deviation is listed at the end with its reason.

## Compact ride HUD (owner-directed revision, 2 Nov 2026)

The owner rode Assisi on 2 Nov and found the HUD "enormous ... all crammed to the top". The
ride-HUD mockup is revised (`v2-ride-hud.html`, marked *owner-directed revision, 2 Nov*;
Home / Devices / Show / Finish mockups stand) and the build follows it:

- **One band at the bottom edge:** Exit, speed, time, distance, grade, power, gear (cadence and
  heart rate only when a sensor delivers them) | Pause, Finish (`h-10`) | one ride-details
  toggle. Phones: three figures (units as labels) + icon transport, then a
  "grade · power · gear" line.
- **One status chip** above the band's start: every trainer / controls / HR-strap / toast state
  ("Trainer lost · tap to reconnect", "Trainer lost · demo power", "Controls locked"). Tap
  reconnects a granted trainer or opens the in-ride devices sheet (the Devices screen's rows).
  The Toaster draws nothing while the chip hosts notices, so there is no red box anywhere.
  Phones show the chip only when something is wrong.
- **Ride details, collapsed by default (persisted):** route card (name, to go, profile with
  you-are-here dot, next place, inline weather), route map, ride tools (Show, Camera, Ghosts,
  Voice, Settings). sm+: one 20rem column on the band's left edge, clear of the rider; phones:
  route card + map at the top edge (no room above the band clear of the wheels), tools above
  the band. One flow column: nothing can overlap (`panelOverlaps: []` on every shot).

### Ride-UI area (`scripts/v2-build-shots/hud_area.py`)

Sum of `getBoundingClientRect()` areas of every visible HUD surface over the canvas (background,
border or shadow; outermost only; clipped to the viewport) / viewport area. Union (overlaps
counted once) in brackets. Golden hour, trainer connected, Tiber river park at 9.06 km.

| Viewport | Collapsed (default) | Trainer lost (chip) | Details open |
|---|---|---|---|
| 1440×900 | **4.9 %** (4.9) | 5.1 % (5.1) | 12.0 % (12.1) |
| 390×844 | **9.7 %** (9.8) | 12.8 % (12.8) | 26.6 % (26.8) |
| 1920×1080 TV | **9.4 %** (9.6) | 9.6 % (9.9) | 22.9 % (23.3) |

Collapsed, the ride UI is well under the 15 % budget everywhere, and the topmost HUD pixel is at
85 % (1440) / 88 % (390) of the screen height: nothing at the top. Details open is the rider's
explicit choice (one tap back); on phones it covers 27 % because the route card and map need
the room.

Owner camera (Assisi valley, night, 1280×658 @2, rider at 220 m): PR #27 head 5954f7e
**15.9 %** (Exit, route card, status pill, three tools at the top + strip) → compact HUD
**7.4 %** (band + chip), 7.5 % with the trainer link failed ("Trainer lost · demo power" in
the chip, where the owner's shot had a "Connection failed" card).
`compare/ride-hud-owner-camera-assisi-night.jpg` (owner's own screenshot | PR #27 head |
compact | compact + failed link), raw numbers in `owner-camera/*.json`.
Re-shoot: `scripts/owner-camera-hud-shot.py` + `scripts/owner-camera-hud-compare.py`.

States shot per viewport and theme: `ride-hud-*` (collapsed), `ride-hud-open-*`,
`ride-hud-lost-*` (trainer lost mid-ride, store-level: the reconnect gave up, trainer still
granted), each against the mockup's matching state (`?tray=open`, `?state=lost`).

## Side by side (mockup | build)

`compare/<screen>-<viewport>[-night].jpg` for home, ride-hud, devices, finish and show
× 1440×900, 390×844 (@2x) and 1920×1080 TV, day and night (30 composites).
Raw build shots sit next to this file; per-shot measurements in `measurements-*.json`.
Extra states: `devices-empty-1440.jpg` (nothing paired), `devices-error-1440.jpg`
(couldn't find it), `devices-nobt-390.jpg` (no Web Bluetooth).

### Staging (rework round 2)

The first round shot the build in demo state on the flat world, against mockups that show a
connected trainer mid-ride on the rich world. The composites now compare design, not state:

- **World:** the P2.1 world (materials, trees, landmarks; this branch is stacked on
  `velo/p2.1-world-materials`), pinned to the golden-hour preset, clear sky, through
  `window.__veloWorldLight`. Show mode: drone camera, as mocked.
- **Trainer:** a fake granted `KICKR CORE 78C1` over a fake `navigator.bluetooth` (no
  hardware), reconnected through the real Devices row, streaming FTMS Indoor Bike Data
  (24.6 km/h, 142 W). Every screen shows the trainer connected, as the mockups do.
- **Ride state:** ride HUD at the mockup still's place on the route (Tiber river park,
  9.06 km — the tree avenue of the world still), show mode on Assisi valley floor at 3.0 km,
  Finish after a ride to the end of Tiber river park (36 min of 5 s samples at 142 W). The
  values come from the dev server's own `rideStore`; nothing in `src/` is faked.
- **Weather:** Open-Meteo answered locally with one fixed reading (clear, 14 °C, light
  breeze) so day and night shots read the same.
- **Fonts and clock:** each shot waits until Source Serif 4 has loaded
  (`document.fonts.check`); clock pinned to 1 Nov 2026 16:30 Europe/Rome (show: 2 Nov, the
  day Today's ride is Assisi), en-GB.
- **Rider:** the v2 default rider (dark kit, white helmet, terracotta accent); the cyan test
  rider no longer appears.

Re-shoot: `scripts/v2-build-shots/<screen>.py` against a **dev** server (the staging imports
`/src/stores/*.ts`), then `scripts/v2-build-shots/compare.py`.

## Measured on every shot

| Check | Result |
|---|---|
| `backdrop-filter` elements | 0 on all 48 shots (ride HUD: 18 incl. open + lost states; show included) |
| Horizontal overflow | none |
| Smallest target | 40 px (`h-10`) desktop/phone; 70 px on TV (1rem = 28px) |
| Smallest text | 12 px (`text-xs`, footer/kickers); 21 px on TV |
| HUD panels over the rider box | none (ride-hud `covering: []`) |
| Page errors | none |

Home 1440, computed styles mockup vs build (`getComputedStyle`, same selectors): title,
device pill, label card (rect 232,364 432×340, padding 24, radius 10, shadow
`0 4px 16px -4px rgb(20 15 11 / 0.18)`), kicker, title, subtitle, elevation line, figures,
weather line and Ride button (113 vs 112 px wide) match to the pixel.

## Glass without blur

Mockup panels are translucent paper over the scene (`hsl(var(--hud) / 0.9)` +
`backdrop-filter: blur`). Blur over the live WebGL canvas costs 10–25 fps (PR #16), so the
build gets the look without it:

- `hud-surface` (src/index.css): a top→bottom alpha gradient of `--hud`
  (`--hud-a-top` 0.88 → `--hud-a-bottom` 0.85 by day; 0.93 → 0.87 at night, where umber over
  a sunlit scene washes out faster), a fixed grain tile (`public/textures/hud-grain.png`,
  128 px, black/white noise at ~2 % mean alpha — static, no per-frame cost), a 1 px top highlight and the soft diffuse
  `--shadow-hud`. Used by `HUD_PANEL`, `Button variant="hud"` and the legacy `.glass` panels
  inside `.hud-flat`.
- Contrast floor: the bottom alpha keeps muted HUD text ≥ 4.5:1 over the darkest scene
  (tree shade, L ≈ 15 %): 4.64:1 by day, ≥ 5.2:1 at night.

## HUD fps (P1.4 property), Arc iGPU, `scripts/world-hud-fps.py`, medium, 1920×1080

Production builds (`vite build` + `vite preview`), Assisi valley route, alternated with the
P2.1 base (`velo/p2.1-world-materials` dddac3a, the same world without this HUD) on the
same machine to separate load from code:

| Run | Build | HUD-on 90 s avg | frames > 20 ms | load1 |
|---|---|---|---|---|
| 1 | P2.1 base | 48.9 fps | 8.5 % | 3.1 |
| 1 | this branch | 57.7 fps | 2.2 % | 1.7 |
| 2 | P2.1 base | 58.7 fps | 0.8 % | 1.1 |
| 2 | this branch | **60.0 fps** | **0.0 %** | 1.2 |

Run 2 is the clean measurement (≥ 58 fps target met; `backdropHud: []`). Run 1 shared the
box with the KDE file indexer (suspended for run 2) and another agent's browser; its dips
hit the base harder than the branch. Raw JSON in `fps/`.

## UI-RULES §9 rubric

1. **Tokens only** — pass. `uiRules.test.ts` green, allow-list unchanged;
   `grep -E "#[0-9a-f]{3,6}|[0-9]+px" src/components/velo` returns nothing. New tokens
   (`--hud-a-top/-bottom`, `--hud-highlight`, `--shadow-hud`, `hud-surface`) are documented
   in UI-RULES §2/§3.
2. **One clear primary action** — pass. Home: Ride on Today's ride (only filled button);
   Devices: Ride; ride HUD: Pause/Resume; Finish: Back to Home.
3. **1440 legible, nothing stretched** — pass (compare/*-1440*.jpg; plates capped with
   `max-h-hero-fit` / `max-h-finish-fit`).
4. **390 single column, no overflow, primary reachable** — pass (overflow false on all;
   Devices Ride is sticky at the bottom; Finish actions full width).
5. **Targets ≥ h-10, primary h-12** — pass (min 40 px; Ride/Finish/Resume `lg` = h-12).
6. **Copy §6, no training nagging** — pass. No scores, PRs, TSS on Home or Finish.
7. **§8 states** — pass. Loading skeletons (plate-shaped), weather offline said once,
   Devices empty / error / no-Bluetooth / connected, Strava error sentences with the fix,
   trainer reconnecting/lost on the HUD chip; Home's device pill names a trainer paired in
   an earlier session with its dot off.
8. **Light and dark** — pass, every screen shot both ways.
9. **Accessible names, roles, focus** — pass. Icon buttons named (Exit, Camera: <mode>,
   Ride settings, Close show mode); the ride Settings menu is a labelled group with
   `aria-expanded`, Escape and outside-tap close; rider pills `radiogroup`; show sizes
   `radiogroup`; Finish is a labelled `dialog` with focus on open.
10. **Belongs to the same product as the reference** — pass; the composites are the new
    reference (UI-RULES §10).

## Deliberate deviations from the mockups

- **Ride Settings opens a menu** (in the ride details): "Rider and trainer" (the full settings
  panel) first, then what the mockup has no button for (night colours, sounds, invite,
  shortcuts, gesture help, VR/AR). No "…" button, no floating "?" chip.
- **Next landmark** shows only real places: OSM POIs from the world bundle that the road
  passes within reach of (≤ 400 m for towns and villages, ≤ 150 m for churches, landmarks
  and viewpoints; never summits), or a detected climb. Routes without either show no line. Live distances differ from the
  mockup's examples (Ponte Valleceppi is the next place only before 6.6 km).
- **World labels** (place names floating over the P2.1 world) belong to the P2.1 renderer,
  not this HUD; the mockup still predates them.
- **Show mode:** "Watch another tab" (Document PiP) is P2.3 and not built; the corner shows
  the Camera button there. On phones the video bar keeps a close button (the phone mockup
  has no way out of show mode).
- **Finish:** "N of M postcards found" appears only when the ride had postcards; the world
  renderer has no postcards yet (play layer packet), so the Tiber ride shows none.
- **Home tiles:** the "Map view" badge appears only in areas that mix 3D worlds and map
  rides (UI-RULES §7: a badge must carry information). Screen readers hear "map view" on
  every map tile.
- **Devices** reflect only what the stores model: one handlebar row (no right-side
  controller to fake), "Test buzz" + "What the buttons do" / "Disconnect" from P2.5, the
  heart-rate row and the ERG option. Nothing is faked as connected outside the shot fakes.
- **Day/night** moved from Home's top bar (the mockup has two controls there) into
  Settings > Visual > Colours and the ride Settings menu.
- **Rider rename** moved from Home's pills (the mockup has no pencil) to Settings > Rider.
