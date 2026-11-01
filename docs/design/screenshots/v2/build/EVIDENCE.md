# P2.4 build evidence: warm-atlas identity

Built from the approved mockups `docs/design/mockups/v2-{home,ride-hud,devices,show,finish}.html`
and the token delta in `docs/design/v2-identity.md`.

## Side by side (mockup | build)

`compare/<screen>-<viewport>[-night].jpg` for home, ride-hud, devices, finish and show
× 1440×900, 390×844 (@2x) and 1920×1080 TV, day and night (30 composites).
Raw build shots sit next to this file; per-shot measurements in `measurements-*.json`.
Extra states: `devices-empty-1440.jpg` (nothing paired), `devices-error-1440.jpg`
(couldn't find it), `devices-nobt-390.jpg` (no Web Bluetooth).

Re-shoot: `scripts/v2-build-shots/<screen>.py` against a dev server, then
`scripts/v2-build-shots/compare.py --only <screen>` (pinned clock 1 Nov 2026 16:30
Europe/Rome, en-GB).

## Measured on every shot

| Check | Result |
|---|---|
| `backdrop-filter` elements | 0 on all 36 shots (ride + show included) |
| Horizontal overflow | none |
| Smallest target | 40 px (`h-10`) desktop/phone; 70 px on TV (1rem = 28px) |
| Smallest text | 12 px (`text-xs`, footer/kickers); 21 px on TV |
| HUD panels over the rider box | none (ride-hud `covering: []`) |

## HUD fps (P1.4 property), Arc iGPU, `scripts/world-hud-fps.py`, medium, 1920×1080

Production builds (`vite build` + `vite preview`), Assisi valley route, alternated with
main `afedf4c` on the same machine to separate load from code:

| Run | Build | HUD-on 90 s avg | frames > 20 ms | load1 |
|---|---|---|---|---|
| 1 | this branch | 55.7 fps | 1.9 % | 7.9 |
| 1 | main afedf4c | 44.6 fps | 13.8 % | 5.8–7.7 |
| 2 | this branch | **60.0 fps** | **0.0 %** | 4.9 |
| 2 | main afedf4c | 56.0 fps | 5.6 % | 7.2 |

Run 2 is the clean measurement (≥ 58 fps target met; `backdropHud: []`). Run 1 shares the
box with another project's pytest and the KDE file indexer; the dips (29 fps in one 5 s
window) hit main harder. Raw JSON in `fps/`.

## UI-RULES §9 rubric

1. **Tokens only** — pass. `uiRules.test.ts` green, allow-list unchanged;
   `grep -E "#[0-9a-f]{3,6}|[0-9]+px" src/components/velo` returns nothing. New tokens
   (`hud`, `scrim`, `on-scrim`, `font-display`, plate aspects, layout utilities) are
   documented in UI-RULES §2.
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
   trainer reconnecting/lost on the HUD chip.
8. **Light and dark** — pass, every screen shot both ways.
9. **Accessible names, roles, focus** — pass. Icon buttons named (Exit, Camera: <mode>,
   Ride settings, More ride options, Close show mode); rider pills `radiogroup`; show sizes
   `radiogroup`; Finish is a labelled `dialog` with focus on open.
10. **Belongs to the same product as the reference** — pass; the composites are the new
    reference (UI-RULES §10 updated).

## Deliberate deviations from the mockups

- Home header adds a day/night toggle (the mockup has no way to switch theme).
- Ride HUD adds one "More ride options" button holding the legacy tools the mockup
  dropped (map, theme, sound, ghost, invite, shortcuts, voice, VR/AR when supported).
  The desktop minimap is on demand from there, not always on.
- The HUD "next landmark" line shows only real data (detected climbs); routes without one
  show no line rather than an invented landmark.
- Show mode: "Watch another tab" (Document PiP) is not built — that is packet P2.3.
- Home tiles: "Map view" badge appears only in areas that mix 3D worlds and map rides
  (UI-RULES §7: a badge must carry information). Screen readers hear "map view" on every
  map tile.
- Devices: the heart-rate and handlebar rows reflect only what the stores model; nothing
  is faked as connected.
