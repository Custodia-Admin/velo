# P3.3 TV mode: evidence

Branch `velo/p3.3-tv-mode-t_fe045c45`, off main 53f202d. Contract: blueprint §P3.3
(as built notes there), UI-RULES §5 TV addendum. Since PR #37 deleted the phone
companion, the TV is driven by the Zwift Ride handlebars and a keyboard or TV
remote.

## What turns the TV layout on

`src/lib/tvLayout.ts`, applied before first paint (`main.tsx`) and followed
live by `useLayoutMode` (App). In priority order:

1. `?layout=tv|default` (kept for the tab, since the router drops the query).
2. Settings → Visual → Layout, set to TV or Standard.
3. Auto (the default): `(min-width: 1600px) and (not (any-pointer: fine))`.

Checked in real Chromium (`e2e/tv-remote.spec.ts`, first test):

| Screen | TV layout |
|---|---|
| 1920×1080 with no mouse (touch emulation) | on |
| 1920 px laptop with a mouse | off |
| Android tablet: 1280×800 at 2×, touch | off |
| Laptop with Settings → TV | on |

Unit tests (`useLayoutMode.test.ts`) cover the 1600 px edge, the 1706 px
tablet, the media-query change, and the precedence order.

## Keys only, 1920×1080 (`e2e/tv-remote.spec.ts`)

The walk goes Home, ride, expand details, pause, finish, Home. It uses only
ArrowDown/Left/Right/Up, Enter and Escape. At every step the test asserts that
the focus ring is on the control the next key acts on. It also asserts the ring
is the TV ring (a solid 7 px outline, on screen):

| Step | Ring on | Key |
|---|---|---|
| Home | Ride (lands there) | Enter |
| Riding, first arrow | Pause | → |
| | Finish | → |
| | Show ride details | Enter |
| Details open | Hide ride details | ↑ |
| Inside the details | | Escape |
| Details closed | the toggle; the ride is still running | Enter |
| Details open | | ← ← |
| | Pause | Enter |
| Paused | Resume | → |
| | Finish | Enter |
| Finish page | Home (lands there) | Enter |
| Home | Ride | |

A second test checks every HUD button and the ride strip against the 5 %
overscan frame.

Local run against the production build: 3 / 3 passed. CI has the final word.

## Handlebars

The menu layer is `src/lib/tv/handlebarNav.ts`. `src/lib/controllers/*` is
untouched.

- **Riding:** the P2.5 ride map keeps every button it maps (unit-tested button
  by button). Y opens the details and B closes what is open.
- **Ready or paused:** the D-pad and A drive the menu as well. Shifting and the
  hoods stay with the ride map.
- **Finished:** only the finish page acts.
- **Off the ride:** D-pad, A and B.
- **Show mode:** Y, Z and B stay with the player.

Harness walk on the fake Zwift Ride, with no hardware:

1. Devices: B goes Home.
2. A starts the ride.
3. D-pad up still sets the hills.
4. Y opens the details and B closes them. B again does nothing; it never pauses.
5. A pauses, → moves to Finish, A finishes.
6. A on the finish page goes Home.

## Composites (mockup | build)

The composites are in `compare/tv-*.jpg`. The build shots (`tv-*.jpg`) come
from `scripts/v2-build-shots/tv.py`, which drives the remote flow with keys.

- **States:** devices, home, ride-hud, ride-hud-open, ride-hud-paused, finish
  and settings.
- **Viewports:** 1920×1080, 3840×2160 shown at half size, and day and night.
- **Settings:** also at 1440 and 1280×648 @2.
- **Overlay:** the red dashed frame is the 5 % overscan line.

Self-review (vision, against the mockups):

- **Home, ride HUD (all three states), finish ring and Devices:** on-system.
  The ring placement, insets inside the frame and type scale match, the 4K side
  to within about 1 px.
- **Finish:** the stats row, the missing attribution line and the button
  labels differ from the P2.4 mockup. All of these are already on main (finish
  rebuild 4f884ff, de-brand); this branch only adds the ring and the overscan
  padding. The hero is shorter on TV because the page now keeps out of the
  frame.
- **Settings → Visual → Layout:** uses the same picker cards as Colours.
  Selected and ringed states read differently. The hint is `text-sm`.
- `measurements-tv.json` per shot records the ring (label, outline width, root
  font) and any control outside the overscan frame:
  - **HUD, Home, finish:** none.
  - **Devices, settings:** only content below the fold of a scrolling page or
    dialog. A focused control scrolls fully inside the frame
    (`scroll-padding`).
- **Root font:** 28 px at 1080p and 56 px at 4K. The ring is 7 px and 14 px.

## Nothing regressed at 1440 and 1280×648 @2

Main 53f202d and this branch were rendered with the same scripts and the same
staging (`tv-mode/regress-*.jpg`, main | branch;
`tv-mode/regress-pixdiff.json`):

- **Home, Devices, finish:** pixel-identical, at most 0.017 % of pixels over
  24/255. The only spot is a ~60×11 px live-text patch on devices-1440-night.
- **Ride HUD (closed and open):** the 3D scene moves between runs, so pixels
  differ. Every HUD panel rect (strip, chip, details, route, map, tools, exit,
  pause, finish, toggle) is identical, and so is the minimum font.

## Known follow-up (not in this PR)

Legacy Settings tabs still have fixed px text that does not scale on TV, such
as the Controls tab hints at 11 px. UI-RULES lists the TV-facing surfaces as
Home, HUD, show and finish, and those are covered here.
