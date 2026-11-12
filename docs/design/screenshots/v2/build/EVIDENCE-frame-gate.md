# World view: no frames queued past ~3 s of GPU work (card t_946833f0)

Branch `velo/gpu-frames-in-flight-t_946833f0`, stacked on PR #105
(`velo/finish-pause-render-t_c4842aa7`, head 0cae127). Base for every
comparison below is 0cae127's production build (`index-BuwB_xtQ.js`); the
branch build is `index-CU_-sr_3.js` (same code as the commit, token-free:
`VITE_CESIUM_ION_TOKEN=` empty).

## The problem

Playwright's `chrome-headless-shell` (CI's browser) has no swap-chain back
pressure. On SwiftShader the world view submitted frames far faster than the
GPU process ran them, and leaving a ride destroys the WebGL context, which
waits for every queued command. Card t_c4842aa7 traced it: the renderer main
thread blocked in `ImplementationBase::WaitForCmd`, the GPU process in
`GpuChannel::OnDestroyCommandBuffer`, for 43–48 s. The e2e specs at
1920×1080 had to run on low.

## The change

`src/renderers/three/frameGate.ts`. Every world frame draws through one
`FrameGate`:

- r3f's own render is off (a priority-1 `useFrame`). `SceneDraw` (plain
  render) or `PostFx` (the composer, high tier) is the one place a frame is
  drawn.
- Each drawn frame is fenced (`fenceSync`). The fences are polled without
  blocking (`clientWaitSync(fence, 0, 0)`) at the next frame.
- A frame is held back (not drawn at all) while 2 or more frames are
  unfinished AND they add up to 3 s or more of GPU work. The GPU's time per
  frame comes from the fences (smoothed). Until a frame has been timed, 2
  frames is the limit. The scene still updates every rAF, and the next drawn
  frame shows the latest state.
- The meter (`?perf=1`, `__veloPerf`) and `ReadySignal` count drawn frames.
  `__veloRideDebug().frameGate` shows `{drawn, held, inFlight, gpuFrameMs}`.

### Why a time budget and not a frame count

The first version held at 2 frames in flight. Chrome reports a fence done
long after the frame ran on a real GPU: with vsync off on cat-bed's iGPU,
0.73–1.24 s after submit, with ~95 frames reading as unfinished at
105–113 fps. A two-frame count cost real GPUs frames (cat-bed iGPU 2 runs
per variant, `variants.jsonl`; laptop Arc 1 run, `probe-laptop.jsonl`; both in
the handoff dir):

| Setup | No gate | Two-frame count |
|---|---|---|
| Laptop Arc, Chrome, 60 Hz | 60.0 fps | 47.8 fps (57 frames held per 5 s) |
| cat-bed iGPU, Chrome, vsync off | 51–108 fps | 37–70 fps |
| cat-bed iGPU, headless shell, vsync off | 101–121 fps | 85–100 fps |

Counted in GPU time, ~95 frames of ~9 ms each is under 1 s of work, far under
the 3 s budget. SwiftShader's ~1.5 s per 1080p frame holds it to 2–3 frames.

## CI's browser on software GL: Finish → Home

Setup: cat-bed, headless shell from Playwright 1.64.1 (`chromium_headless_shell-1248`),
SwiftShader, pinned to 4 cores (`taskset -c 8-11`), nothing else running. A
10 s ride at medium, 1920×1080, 3 s on the finish page, then Home (click to
`#home-title` visible). Base and branch runs were interleaved, 3 each
(`backlog2.sh` / `trace_home2.py`). Raw data:
`frame-gate/finish-home-headless-shell-world.jsonl`.

| World (Tiber park) | base 0cae127 | branch |
|---|---|---|
| Finish → Home | 35.2 / 35.6 / 38.8 s | **0.24 / 0.55 / 0.55 s** |
| GPU process in `OnDestroyCommandBuffer` (trace) | 35.2–38.8 s | 0.21–0.52 s |
| rAF during the ride | 0.8–1.0 /s | 60 /s |
| Ride clock advanced in 10 s | 0.58–0.85 s | 10.0 s |
| Frames drawn during the ride | 0.8–1.0 /s | 0.6 /s (2–3 in flight, `gpuFrameMs` 1.4–1.5 s) |

On base, the GPU queue also blocked the main thread during the ride: rAF fell
to ~1/s, and the ride clock (which runs on rAF) nearly stopped. With the gate
the ride runs in real time and the screen updates as fast as SwiftShader
draws. Straight from the ride to Home (0 s on the finish page) the branch took
~3 s (2 runs, before the final cleanup; the gate logic is the same).

Photoreal (Cesium, Bellinzona–Locarno, no token) needs no gate. Finish → Home
was 33–36 ms on both builds (`frame-gate/finish-home-headless-shell-photoreal.jsonl`).
Cesium's frames block the main thread on SwiftShader (rAF 1.5–2.2/s on both
builds), so nothing piles up behind them.

## e2e at medium, CI's browser

The `tv-remote.spec.ts` + `finish-cover.spec.ts` specs ran at medium on cat-bed:
bundled headless shell, SwiftShader, 4 cores, `--workers=2` (as a 4-vCPU CI
runner). Log: `frame-gate/e2e-medium-headless-shell.log`.

| | base 0cae127 | branch |
|---|---|---|
| Result | 6 passed (1.5 min) | 6 passed (1.2 min) |
| finish-cover world test | 51.5 s | 27.5 s |
| World Finish → Home (logged) | **32,279 ms** | **48 ms** |
| Frame gate at the second finish | n/a | drawn 10, held 727, 2 in flight, 1.6 s per frame |

Base also passes here, on 4 dedicated cores, but only by waiting 32 s for Home.
CI's shared runners turned that wait into the 15 s+ failures of run
43026470671.

## Real GPU: frame rate unchanged

### cat-bed Intel iGPU (Arrow Lake, ANGLE gl-egl), 3 runs each

Setup: 1920×1080 medium, Tiber park, an 8 s settle, then 3 windows of 5 s
per run. Base and branch were interleaved, pinned to cores 12–15, with the
machine idle (load 0.2–2.0). Raw data: `frame-gate/real-gpu-cat-bed.jsonl`.

| Browser, mode | base drawn fps | branch drawn fps | frames held (branch) |
|---|---|---|---|
| Chrome stable, vsync (riders) | 60.2–60.2 | 60.2–60.2 | 0 in 9 windows |
| Chrome stable, vsync off | 105.6–118.8 | 104.0–129.2 | 0 in 9 windows |
| Headless shell, vsync | 60.2–65.6 | 58.0–60.2 (rAF 57.8–60.0) | 0 in 9 windows |
| Headless shell, vsync off | 54.1–120.5 | 56.5–134.6 | 0 in 9 windows |

### Laptop Intel Arc (ANGLE Vulkan): see the PR

The laptop pass ran while other agents' e2e runs had the laptop at load 6–34,
including a SwiftShader GPU process at 400 % CPU. Base itself ranged from 5 to
35 fps, so those numbers can't show a difference. With vsync (riders' setting)
the branch held 0 frames in all 18 windows, even under that load. With vsync
off, 4 of 18 windows held frames. In those windows the GPU process was over
3 s behind, and drawn fps stayed within base's range in the same pass
(vsync off: branch 5.3–33.2 fps, base 7.7–34.3 fps). The PR records a rerun on an idle laptop.

## Tests

- `frameGate.test.ts` (15): the gate against a simulated in-order GPU, with
  fences seen late. Cases:
  - A fast GPU is never held.
  - Fences 150–900 ms late at 60 fps are never held; a two-frame count loses
    600+ frames.
  - A GPU-bound real GPU keeps the GPU busy.
  - SwiftShader-like 2 s frames are held to 2 in flight.
  - A mid-speed GPU stays within the budget.
  - A pause doesn't poison the pace.
  - A lost context frees everything.
  - WebGL 1 / no sync objects draws every frame.
  - A new context starts afresh.
- `ThreeWorldView.frameGate.test.ts` (7): the world view takes over the
  render at priority 1, draws through the gate (plain and composer), the
  meter counts drawn frames only, and `ReadySignal` waits for drawn frames.
- Locally: `tsc -b --noEmit`, `eslint src e2e`, and 32 three-renderer / perf /
  ride test files (268 tests). The full suite runs in CI.

Scripts: `~/.hermes/handoffs/velo/t_946833f0/`. `backlog2.sh` + `trace_home2.py`
measure Finish → Home with a trace. `gpu_run.sh` / `laptop_run.sh` +
`gpu_fps.py` + `summarise.py` measure real-GPU fps. `diag.py` reports fence
lag and frames in flight (needs an experiment build).
