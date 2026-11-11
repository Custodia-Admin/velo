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

## Software GL, 1920×1080, medium (the CI case)

These runs used cat-bed with Chrome on SwiftShader (the CI flags), pinned to
4 cores as a stand-in for a CI runner. Main and branch runs were interleaved,
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
paint, waiting behind the hidden world frames. On a CI runner that was 15 s
or more (run 43026470671). Photoreal Home was never slow.

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

`e2e/finish-cover.spec.ts` rides at 1920×1080 on medium, on both renderers.
Behind the finish page it expects zero draw calls. After Ride again it
expects draws to resume and the ride clock to run, then a second finish and
Home.

- On cat-bed, with Chrome pinned to 4 cores, the branch passed 2/2, both
  alone and in parallel with `tv-remote.spec.ts`.
- Against main's dist it fails both tests, with 340 and 1,363 draw calls in
  4 s.

`tv-remote.spec.ts` is back on medium after the low-graphics workaround,
and it passes on the branch.
