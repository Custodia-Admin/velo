# P2b Journey & Show mode — design review notes

Gate per [`UI-RULES.md`](UI-RULES.md) §0: mockup → vision review → build →
1440/390 compare. Screenshots live in
[`screenshots/p2b/`](screenshots/p2b/); mockup source is
[`mockups/p2b-show-mode.html`](mockups/p2b-show-mode.html).

## 1. Mockup round 1 → fixes before build

| Finding (vision review of mockup renders) | Fix |
| --- | --- |
| Stats strip figures too small for 2 m (`text-2xl` at 1440) | Figures `text-2xl` → `lg:text-3xl`; labels `text-xs` → `lg:text-sm` |
| "Camera: Auto" mixed into the stats strip; unclear if data or control | Moved into the show panel as a button (`Camera · Auto`) |
| 390 chooser too tall: picture-in-picture steps always open | PiP steps folded into a `<details>` disclosure with a chevron |
| Two equal-weight buttons in the chooser ("Choose" and "Continue") | One accent button: "Continue …" when a previous video can be reopened, otherwise "Choose videos" |

Round 2 renders (`mockup/show-*.jpg`) passed: one accent button, no overflow
at 390, controls row fits on one or two lines.

## 2. Build-time findings (measured with Playwright, not eyeballed)

| Finding | Evidence | Fix |
| --- | --- | --- |
| Top bar overflowed at 390 once "Show" was added: last button at x 371–413 | `getBoundingClientRect` probe | Ghosts toggle is icon-only below `sm`; Show now 324–366 |
| Gesture legend's full-screen wrapper had `pointer-events-auto` and swallowed every click on the top bar (Exit, Theme, Sound…) — pre-existing upstream bug | Playwright: "subtree intercepts pointer events" | Wrapper is click-through; only the `?` chip and its dialog take events. Chip hidden in show mode (it sat on the strip) |
| No-token banner (100 px tall at 390) overlapped the strip and the Pause button | banner 652–752 vs strip 614–684, Pause 725–765 | Banner hidden in show mode; strip at `bottom-40` below `lg` |
| Speed read `0.0 km/h` while distance advanced (rides before a trainer is paired) — pre-existing | strip `0.0 KM/H` with distance 0.2 → 0.5 km | `rideStore.tick` keeps ingest speed only with a connected trainer; regression test added |
| Ground rendered black (p2a mood-fog bug) | `before/before-ride-1440.jpg` | Same 3-line fog fix as PR #3 (identical hunks) |

## 3. §9 rubric

| # | Check | Result |
| --- | --- | --- |
| 1 | Tokens only; `uiRules.test.ts` green, checked set grew (3 new files in `src/components/velo/`) | pass |
| 2 | One primary action per view: Home "Ride" (accent) + "Ride and watch" (outline); in-ride the video's Play/Pause is the only accent button | pass |
| 3 | 1440 legible from 2 m: figures `text-3xl`, labels `text-sm`, panel 720×405 video (M), nothing stretched | pass |
| 4 | 390 single column, `scrollWidth` = viewport (no overflow), no overlaps (measured), primary reachable | pass |
| 5 | Targets ≥ `h-10`; Play/Pause `h-12`; seek bar `h-10`; S/M/L `h-10` | pass |
| 6 | Copy: "Ride and watch", "Choose videos", "Use picture-in-picture", "Close show"; no training language | pass |
| 7 | States: choose (empty), loading ("Opening …"), playing, ended → next video, can't-play error, picker error, PiP bar, finished (panel hides) | pass |
| 8 | Light and dark rendered (`after/*-light.jpg`) | pass |
| 9 | Icon buttons have accessible names; size picker is `radiogroup`/`radio` with `aria-checked`; Show toggle `aria-pressed`; focus ring untouched | pass |
| 10 | Side by side with before + mockup (`compare/`): same glass surfaces, tokens and type scale as the P2a Home reference | pass |

## 4. What the end-to-end run proved (`scripts/show-shots.py`, Demo Mode, no BLE)

- "Ride and watch" → file chooser → ride autostarts with the video playing
  (`currentTime` 21.6 s at the first shot, `paused: false`, `readyState` 4).
- HUD fades after 4 s idle; panel controls hide; video stays.
- Auto camera running (`Camera · Auto`); chase for 45 s, then drone.
- Ride keeps recording: time/distance advance throughout; Finish → **Export
  .FIT** downloads a 1.8 kB file with the show still open.
- Resume position saved (`globeride.velo.showResume.v1`, ~58 s).

## 5. Not covered / known limits

- The File System Access "Continue <title>" button needs Chrome's native
  picker, which Playwright can't drive; automation used the
  `<input type=file>` path (and its "Pick X again to carry on" hint).
- Streaming services: guidance only (Chrome picture-in-picture). No
  integrations, by design.
- Photoreal tiles not shown: the local `.env.local` ion token is a
  placeholder, so the map fallback renders. Same layout with a real token.
- Nothing tested on the bike; no BLE commands sent.
