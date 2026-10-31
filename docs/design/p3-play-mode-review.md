# P3 Play mode — design-gate review

Card P3 (game-like world spike). Spike and recommendation:
[`docs/game-world-spike.md`](../game-world-spike.md). Rules:
[`UI-RULES.md`](UI-RULES.md).

## Gate steps

1. **Rules loaded:** UI-RULES.md, VELO-BRIEF.md.
2. **Mockup:** [`mockups/p3-play-mode.html`](mockups/p3-play-mode.html),
   rendered at 1440 and 390 (`screenshots/p3/mockup/`).
3. **Vision review of the mockup** found: a dot row nobody would read from
   two metres, two grey note lines too small and low-contrast, and a long
   buddy line at 390. Fixed before building: dots removed, one note line at
   `text-base` in `foreground`, count as the `text-2xl` figure.
4. **Build:** tokens and `Card` only; new UI lives in
   `src/components/velo/PlayMode.tsx` (checked by `uiRules.test.ts`). The
   postcard billboard is a world object drawn in code: paper and ink are
   scene colours, the stamp reads the `--accent` token.
5. **Compare:** `screenshots/p3/compare/` (before | mockup | after) for Home
   and the ride view at both widths. Before = the P2a reference Home and the
   P2a ride view.

Rendered by `scripts/play-shots.py` against `vite preview` with the host GPU
(Vulkan), Demo Mode, no trainer, no Bluetooth. The local ion token is a
placeholder, so the scene is the OSM map fallback; photoreal tiles were not
checked.

## Findings fixed during the build

- **Render loop crash.** The buddy avatar had no position until its first
  update, and Cesium stopped rendering ("reading 'longitude'" in
  `BoundingSphere.projectTo2D`). The avatar is now placed at the route start
  when it's created; a unit test pins it.
- **Buried postcards.** With `RELATIVE_TO_GROUND` the cards were drawn 2.4 m
  above the ellipsoid (0 m) while the rider rides at the route's DEM height
  (~280 m on Lugano), so they were off-screen below the camera. Cards now sit
  at route elevation and are re-seated on the sampled ground as the rider
  gets close. Checked by projecting every card to window coordinates in a
  debug build: the next card was on screen at about 200 m.
- **Horizon clutter.** All 12 cards were drawn at once. Now only cards within
  1.2 km are drawn.
- **390 stack ran into the ride controls.** Adding the panel pushed the
  elevation profile to y = 704 px, past the no-token banner (top 661 px).
  Phones now get a one-row panel, and the mobile minimap gives its place to
  it while Play mode is on. Measured: the stack ends at 528 px with Play mode
  on vs 654 px with it off; Pause/Finish start at 725 px.

## Measurements (Playwright, `getBoundingClientRect`)

| Check | 1440 | 390 |
| --- | --- | --- |
| Horizontal overflow (`scrollWidth`) | 1440 = viewport | 390 = viewport |
| Play mode switch | 64 × 40 | 64 × 40 |
| "Play mode" label left vs "Hills feel" label left | 248 / 248 | 16 / 16 |
| Ride panel | 496 × 134 at (932, 309), under the HUD | 366 × 51 at (12, 324) |
| Panel text at pickup | "Postcards · 1 of 12 · Postcard 1 collected · Anna rides with you · pace from 28 Oct" | "Postcard 1 collected · 1 of 12" |
| Finish card | "Postcards 1 of 12" | "Postcards 1 of 12" |
| Page errors during the run | none | none |

## §9 rubric

| # | Line | Result |
| --- | --- | --- |
| 1 | Tokens only; `uiRules.test.ts` green, checked set unchanged | Pass. New TSX is in `src/components/velo/`; no arbitrary values, no palette colours |
| 2 | One clear primary action | Pass. Home's primary is still Ride; Play mode is a switch beside Hills feel |
| 3 | 1440 legible from 2 m, nothing stretched | Pass. Count `text-2xl`, notes `text-base`, panel matches the HUD column width |
| 4 | 390 single column, no overflow or overlaps | Pass after the fix above (stack ends 197 px above Pause/Finish) |
| 5 | Targets ≥ `h-10` | Pass. Switch `h-10 w-16`; the panel has no controls |
| 6 | Copy §6, no nagging on Home | Pass. "Play mode", "Postcards to collect on the road, and Anna rides beside you." / "Off: just you and the view." No streaks, no score, nothing to miss |
| 7 | States §8 | Pass. Off (renders nothing), no buddy record (level buddy), recorded buddy, pickup note, all collected, finish. Loading isn't a state: the layer is synchronous; the buddy record loads async and the line updates in place |
| 8 | Light and dark | Pass. `*-light-*` shots for Home, ride and finish |
| 9 | Accessible names, roles, focus | Pass. `role="switch"` with `aria-checked`, label and description ids; panel is a labelled `section`; note is `aria-live="polite"`; icons `aria-hidden` |
| 10 | Belongs to the same product | Pass. Same `Card` glass as the HUD, same switch as the ERG switch on Home |

## Not verified

- Photoreal tiles (needs a real ion token): card seating on 3D tiles.
- On the bike. No BLE commands were sent; trainer control is unchanged.
- A buddy from a real ride: the recorded-pace path ran with a seeded
  IndexedDB record, not a ride saved by the app. The recorder writing
  `riderId` on new records has no test of its own.
