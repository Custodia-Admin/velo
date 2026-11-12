# Finish page: the world draws nothing behind it (card t_c4842aa7)

Branch `velo/finish-pause-render-t_c4842aa7`, off main ce60b13.

The finish page (`FinishCard`) is opaque over the whole screen, but the world
under it kept drawing every frame. Now `Ride` passes `covered` to `RideView`
while the finish page shows (`WorldViewProps.covered`):

- three.js: `<Canvas frameloop>` is `'never'` while covered. The canvas, scene
  and WebGL context stay. `SteadyClock` keeps the r3f clock running on from
  the last frame after `setFrameloop` restarts it at 0. Without it, landmark
  pin picks and the perf publish would wait as long as the ride had run.
- Cesium: `viewer.useDefaultRenderLoop` is off while covered and back on
  afterwards. On-demand rendering, which main already used while finished,
  still drew a frame for every tile that arrived. A loop that WebXR turned
  off is left alone, and nothing touches a destroyed viewer.

## Software GL in full Chrome, 1920×1080, medium

These runs used cat-bed with google-chrome-stable (new headless) on
SwiftShader (the CI flags), pinned to 4 cores as a stand-in for a CI runner. Main and branch runs were interleaved,
3 runs each. The script is `measure_finish.py` (handoff dir
`~/.hermes/handoffs/velo/t_c4842aa7/`), and the raw data is
`finish-cover/software-gl-results.jsonl`. Draw calls were counted at the
source: an init-script hook on every WebGL draw call in the page. Frames were
read from `gl.info.render.frame`.

| | main ce60b13 | branch |
|---|---|---|
| World (Tiber park): draw calls in 5 s behind the finish page | 510 / 506 / 429 (6 / 6 / 5 frames) | **0 / 0 / 0** (0 frames) |
| World: Finish → Home (click to `#home-title` visible) | 8,963 / 6,499 / 9,029 ms | **48 / 62 / 579 ms** |
| Photoreal (Bellinzona–Locarno, no token): draw calls in 5 s behind it | 340 / 1,199 / 683 | **0 / 0 / 0** |
| Photoreal: Finish → Home | 27 / 33 / 30 ms | 44 / 44 / 36 ms |
| Ride again → drawing and the ride clock running | n/a | world 123 / 120 / 119 ms; photoreal 319 / 119 / 2,000 ms |
| Second finish (after Ride again): draw calls in 5 s | n/a | 0 on every run |

On main the URL changed to /app within ~10 ms, but Home took 6.5–9 s to
paint, waiting behind the hidden world frames. Photoreal Home was never slow.

## Playwright's headless shell (what CI runs): GPU work queued while riding

CI uses Playwright's bundled `chrome-headless-shell`, not full Chrome. It has
no swap-chain back pressure, so on SwiftShader `requestAnimationFrame` runs
far ahead of the GPU process: about 10 s of riding medium at 1920×1080 queues
40–75 s of GPU work. Leaving the ride destroys the WebGL context, which waits
for all of it. Traces (`trace_home.py`, `backlog.sh`) show it as one
renderer task blocked in `ImplementationBase::WaitForCmd` while the GPU
process spends the time in `GpuChannel::OnDestroyCommandBuffer` (43–48 s).
That is the 15 s+ of CI run 43026470671.

The test rode 10 s at medium, on 4 cores with nothing else running, with the
headless shell from cat-bed's Playwright 1.64.1 cache.

| Time on the finish page before Home | main: Finish → Home | branch: Finish → Home |
|---|---|---|
| 3 s | 48.6 s | 52.7 s |
| 30 s | 49.3 s | **18.1 s** |

On main the queue never drains, because the hidden frames keep feeding it. On
the branch it drains while the finish page is up. A rider reading the
summary gets most of it back, but straight after a ride the queue is still
there. Bounding the GPU work in flight is a separate follow-up.
`tv-remote.spec.ts` therefore stays on low, with its comment corrected, and
the e2e below runs on low and does not time Home.

## Real GPU (cat-bed iGPU, `--use-angle=gl-egl`), 1440×900 and 390×844

The script is `shots.py`, and the data is `finish-cover/gpu-{main,branch}.json`.

| | main | branch |
|---|---|---|
| Frames drawn in 3 s behind the finish page | 180 / 181 (60 fps; 16,200 / 11,765 draw calls) | **0 / 0** |
| Finish page pixels, main vs branch | identical at both sizes (difference bbox: none) | |
| 1.5 s after Ride again | running, 18 m | running, 18 m |
| 5.5 s after Ride again | 65 / 64 m, rider at [721, 557] / [196, 523] | 65 / 64 m, rider at [721, 557] / [196, 523] |
| Landmark pins 5.5 s after Ride again | pin-0, pin-119 | pin-0, pin-119 (picks run again after the paused loop) |
| Canvas-only colour variety after Ride again | 3,149 / 3,885 | 3,121 / 3,910 |

Composites (main left, branch right):

- `finish-cover/compare-1440x900-2-finish.jpg` and `compare-390x844-2-finish.jpg`:
  the finish page, unchanged.
- `finish-cover/compare-1440x900-3-again.jpg` and `compare-390x844-3-again.jpg`:
  5.5 s after Ride again, the same live world, rider and HUD (0:05, 0.1 km).

## e2e

`e2e/finish-cover.spec.ts` rides at 1920×1080 on low, on both renderers. The
pause is the same on every tier, and low keeps the headless shell's queue
short. Behind the finish page it expects zero draw calls. After Ride again it
expects draws to resume and the ride clock to run, then a second finish with
zero draws. Photoreal also goes Home.

- On cat-bed it ran with CI's headless shell, 4 cores and 2 workers,
  alongside `tv-remote.spec.ts` and `context-loss.spec.ts`. The branch passed
  8/8.
- Against main's dist it fails both tests: 657 and 1,925 draw calls in 4 s
  at low (340 and 1,363 at medium).
