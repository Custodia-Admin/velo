# Show & journey mode

The household's second use case: set a journey and watch your shows while you
ride. Blueprint §P2.3. Streaming services can't be embedded in a web app
(DRM, frame blocking), so Velo offers two modes.

## 1. Your own videos (local overlay)

Show mode plays videos saved on the device in a panel over the ride
(`ShowPanel`, mockup `docs/design/mockups/v2-show.html`). The ride HUD
condenses to the show strip (time, distance, grade, next landmark, Pause).

- The corner holds **Watch another tab** and Close (the approved mockup);
  where the browser cannot float the ride, the camera choice takes that slot.
- **Choose videos** or **Choose a folder** (Chrome / Edge desktop: File System
  Access). Several files or a folder play in episode order (`sortForPlayback`:
  S01E02 before S01E10).
- **Next episode without a picker.** What was picked is remembered as File
  System Access handles in IndexedDB (`showLibrary.rememberHandles` /
  `rememberFolder`), and the video being watched in localStorage
  (`markWatched`, with the resume position from `saveResume`). Next time,
  **Continue …** (or Home's "ride and watch") re-opens it with no picker:
  `continueShow.continueLastShow` reads the handles and `nextUp` picks the
  video part-way through, or the one after a finished one (within the last
  20 s counts as finished). A folder also picks up episodes added since.
- Chrome keeps read access for the session. After a browser restart it asks
  once with a small permission prompt (not a file picker); choosing "Allow on
  every visit" removes even that. That is why Continue is a button: the
  prompt needs a click.
- Other browsers (Safari, Firefox, phones) use a plain file input; nothing is
  remembered, and the resume position still applies when the same file is
  picked again.
- Handlebar buttons (Zwift Ride, `lib/controllers/controllerActions.ts`, the
  P2.5 map): Y play/pause, Z next video, B auto camera on/off.

## 2. Ride over anything (journey mode)

The ride view floats in a **Document Picture-in-Picture** window over
another tab (Netflix, YouTube, anything) or another app on the TV
(`ShowSurface`, `lib/show/pip.ts`; mockups `v2-pip.html` and
`v2-pip-window.html`).

- Chrome / Edge 116+ on desktop only. Capability first: the
  **Watch another tab** button only exists where `documentPictureInPicture`
  does. Elsewhere the panel explains Chrome's own picture-in-picture for a
  video tab instead.
- Sizes S, M, L: a quarter, a third and half of the screen width, always
  16:9 (`pipWindowSize`), and never narrower than the JourneyBar needs at
  that size: 448 / 512 / 640 px (`PIP_MIN_WIDTH`). The bar's widest figures
  (1:18:05, 42.2 km, −12.5 %) plus Pause measure 430 px; at the old 320 px
  floor Pause was cut off on a 1280-wide laptop. So a 1280 screen gets
  448 / 512 / 640 and a 1920 screen 480 / 640 / 960. The last size is
  remembered.
  Opening and resizing need a click (Chrome's user-activation rule). Chrome
  caps a picture-in-picture window's size: L came out 923×518 instead of
  960×540 on a 1920×1080 screen (Chromium 153).
- In the window: the world (same renderer and director), the JourneyBar
  (route progress, time, distance, grade at text-3xl, next landmark, Pause),
  the size picker and "Back to the Velo tab". The window scales its own type
  with its width (`html[data-surface='pip']` in `index.css`: 16 px at a 480 px
  corner, 22 px at half). Problems (trainer lost, …) show as one chip.
- The next landmark line never cuts a word at its edge (`NextLandmark`).
  When it is narrow, the place name shortens, then goes ("⚑ in 6.5 km"),
  then the flag goes, then the line shows nothing. The distance is whole
  whenever it shows. At the widest figures (1:18:05, 42.2 km, −12.5 %) the
  640 px window leaves 79–111 px for the line (review of PR #48 @dfd7071).
- The bar covers a quarter of a small window, so the window tells the world
  view how much it covers (`data-hud-bottom`) and the camera shifts its lens
  by half of that (`lib/world/hudLens`): the rider sits in the clear part
  above the bar. A lens shift, not a camera move. The world renderer sets a
  view offset (`applyHudLensShift`); photoreal draws a canvas taller than the
  window by twice the shift, reaching above its top edge
  (`renderers/cesium/hudLensCrop`), because Cesium 1.141 loses
  `PerspectiveFrustum.yOffset` on the frustum clone it renders from. Both
  renderers draw the same vertical field, 60° (`RIDE_FOV_Y_DEG`; Cesium's own
  fov spans the longer side, so photoreal converts it), so the same shift
  clears the bar, wheels included, in both. Measured (and checked: exit 1
  when the wheels are behind the bar) with
  `scripts/v2-build-shots/pip-photoreal.mjs`.
- The Velo tab shows "Your ride is in the floating window" and one action,
  **Bring the ride back**, plus the show strip. Only one world view exists at
  a time (one WebGL context).
- The window closes with show mode, at the finish, and when the ride view
  goes. Closing it brings the ride back to the tab.

### Why the ride keeps going in a hidden tab

The ride loop, recording and FIT export run on `requestAnimationFrame` in the
Velo tab. A hidden tab normally stops getting frames. While a picture-in-picture
window is open, Chrome keeps the opener tab running at full rate even when it
is hidden (measured on Chromium 153: 60 Hz rAF and unthrottled timers with the
window open; frames stop without it). No keep-alive hack is needed.
`e2e/show-mode.spec.ts` (CI job `show-mode`, headed Chrome under xvfb, real
background throttling) pins it: frame rate, ride clock, samples and the FIT
records while hidden, plus a control showing the loop stops with no window.
It drives Chrome over the raw DevTools protocol (Playwright pauses the PiP
window's target, which hangs the tab sharing its event loop, and turns off
the throttling under test). Software GL on a CI runner draws the world at a
frame every few seconds and stalls the frame pipeline whatever the tab
state, so the spec switches the scene off (`window.__veloThree`, opt-in
`velo.debug.three`) around the clicks and the measurement; everything else
runs for real.

## Cinematic director

`lib/world/director.ts` picks the camera while show mode's auto camera is
on (`lib/show/showDirector.ts` drives it from the ride; both renderers call
it every frame).

- Shots: chase, side dolly, drone orbit at a landmark, front, POV
  (`renderers/three/directorCamera.ts` places them in the world renderer; the
  photoreal renderer films them with its calm modes, `CESIUM_SHOT_MODE`).
- A cut every 20–40 s (`SHOT_MIN_S`–`SHOT_MAX_S`), never two within 15 s
  (`MIN_CUT_GAP_S`, the opening shot included), with an eased blend
  (`BLEND_S`, `easeInOutCubic`).
- Held while the rider steers or brakes and for `INPUT_SETTLE_S` after: no
  cut. Steering wins over leaving an orbit.
- Orbits only within 300 m of a manifest POI the route passes
  (`ORBIT_RADIUS_M`, landmarks from `routeLandmarks`), and only when there is
  road enough to reach the next legal cut before leaving that radius, even
  accelerating at 0.5 m/s² (`orbitRoadNeeded`). It leaves the orbit
  `ORBIT_EXIT_LEAD_S` before the edge.
- Deterministic: seeded from the route id (`seedFromString`, `seededRandom`).
  Same route, same inputs, same edit.
- Choosing a camera (button or handlebar) turns the auto camera off.

Tests: `director.test.ts` rides a synthetic winding 24 km road with
landmarks at 15–30 fps with jitter, steering and braking bursts, and checks
every rule frame by frame.

## Manual check (recorded in the PR)

Local video reopens without a picker: on the laptop, choose a folder of
episodes, watch part of one, finish another, close the browser, reopen Velo,
start "ride and watch": the right episode plays at the right place without a
file picker (at most Chrome's one-line permission prompt).

Repeat with several files chosen one by one (not a folder). Velo asks
Chrome about each file in turn, and only the first ask is sure to have the
click's user activation, so it asks first about the episode it plans to
start (worked out from the file names, last time's video and the saved
positions), then the rest (review of PR #48 @dfd7071). If Chrome's restore
prompt doesn't cover them all, the later files are refused. Velo then plays
the episode it would have played with every file allowed, if that one
opened; otherwise the chooser says "Chrome didn’t allow Velo to open last
time’s videos" with Choose videos as its one action. It never skips past a
refused episode, and never says "watched everything" while one was refused
(review of PR #36 @61defbb, F1). Only videos count: a pick remembers only
its videos, and a subtitle Chrome refuses (picked with "All files" before
that) never blocks Continue (review of PR #48 @dfd7071, N1). Record which of
the two happened.

When Continue can't carry on, the chooser says why in one sentence and
makes the matching pick its one filled button (`continueFailureText` in
ShowPanel.tsx, reasons from `continueLastShow`):

| Reason | When | Sentence starts |
| --- | --- | --- |
| `none` | nothing remembered, or the browser's storage can't be read | "Velo can’t reopen last time’s videos on this device." |
| `denied` | Chrome refused access (prompt declined, or no click to ask with): to everything, to the episode to carry on with, or to some files once the rest were watched | "Chrome didn’t allow Velo to open…" |
| `missing` | the files or the folder moved, were deleted, or hold no video | "Last time’s videos have moved…" / "The folder … has moved…" |
| `done` | every video was watched to the end, and Chrome allowed them all | "You have watched everything from last time." |
