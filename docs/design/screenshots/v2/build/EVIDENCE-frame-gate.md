# World view: no frames queued past ~3 s of GPU work (card t_946833f0)

Branch `velo/gpu-frames-in-flight-t_946833f0`, stacked on PR #105
(`velo/finish-pause-render-t_c4842aa7`, head 0cae127). Base for every
comparison below is 0cae127's production build (`index-BuwB_xtQ.js`). Branch
builds: `index-CU_-sr_3.js` (c061b67, the first gate) and `index-Dwv0h2Ya.js`
(5ddd194, the head: one frame at a time once a frame is over the budget). All
are token-free (`VITE_CESIUM_ION_TOKEN=` empty).

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
- A frame is held back (not drawn at all) while the unfinished frames add up
  to 3 s or more of GPU work. The GPU's time per frame comes from the fences
  (smoothed). Until a frame has been timed, 2 frames is the limit. The scene
  still updates every rAF, and the next drawn frame shows the latest state.
- A GPU slower than 3 s per frame therefore gets one frame at a time. In
  c061b67, 2 frames were always allowed. CI's runner took 6.6 s per frame with
  a second test running, and the way Home waited 13.4 s (run 43130528642).
  5ddd194 dropped that floor. The rule is unchanged wherever 2 or more frames
  are in flight and a frame is under 3 s, which covers every real GPU and
  cat-bed's SwiftShader. So the real-GPU numbers below, measured on c061b67,
  hold for the head.
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
`frame-gate/finish-home-headless-shell-world.jsonl` (c061b67) and `-5ddd194.jsonl`. CI log: `frame-gate/ci-43133133507-smoke-ride.log`.

| World (Tiber park) | base 0cae127 | branch |
|---|---|---|
| Finish → Home, c061b67 runs | 35.2 / 35.6 / 38.8 s | **0.24 / 0.55 / 0.55 s** |
| Finish → Home, 5ddd194 runs (no trace) | 35.7 / 39.0 / 36.0 s | **0.41 / 0.71 / 0.04 s** |
| GPU process in `OnDestroyCommandBuffer` (trace, c061b67 runs) | 35.2–38.8 s | 0.21–0.52 s |
| rAF during the ride | 0.8–1.0 /s | 60 /s |
| Ride clock advanced in 10 s | 0.58–0.85 s | 10.0 s |
| Frames drawn during the ride | 0.8–1.0 /s | 0.6 /s (2–3 in flight, `gpuFrameMs` 1.4–1.5 s) |

On base, the GPU queue also blocked the main thread during the ride: rAF fell
to ~1/s, and the ride clock (which runs on rAF) nearly stopped. With the gate
the ride runs in real time and the screen updates as fast as SwiftShader
draws. Straight from the ride to Home (0 s on the finish page) the branch took
~3 s (2 runs on an experiment build with c061b67's gate logic).

Photoreal (Cesium, Bellinzona–Locarno, no token) needs no gate. Finish → Home
was 33–36 ms on both builds (`frame-gate/finish-home-headless-shell-photoreal.jsonl`).
Cesium's frames block the main thread on SwiftShader (rAF 1.5–2.2/s on both
builds), so nothing piles up behind them.

## e2e at medium in CI (GitHub runner, 4 vCPU, 2 workers)

| Run | smoke-ride job e2e | World Finish → Home (finish-cover, logged) | Gate at the second finish |
|---|---|---|---|
| main dacca9e (specs on low) | 14 passed (8.3 min) | n/a | n/a |
| #105 0cae127 (specs on low) | 14 passed (11.0 min) | n/a (not timed on low) | n/a |
| 43130528642, c061b67 (medium) | 12 passed, 1 flaky, 1 failed (8.3 min) | 13,432 ms | 2 in flight, 6.6 s per frame |
| **43133133507, 5ddd194 (medium)** | **14 passed, none flaky (4.1 min)** | **1,773 ms** | 1 in flight, 5.6 s per frame |
| 43134159341 #1, e4da85b (docs only) | 13 passed, 1 flaky (7.4 min) | 3,259 ms | 1 in flight, 6.6 s per frame |
| 43134159341 #2, e4da85b | 14 passed, none flaky (7.4 min) | 5,722 ms | 1 in flight, 5.7 s per frame |
| 43134159341 #3, e4da85b | 13 passed, 1 flaky (7.2 min) | 3,565 ms | 1 in flight, 6.9 s per frame |

Flaky runs:
- **#1, `tv-remote.spec.ts:116`:** the ring check (below).
- **#3, `viewport-1280.spec.ts:96`:** Home's lazy route sections didn't mount
  in 30 s; the retry passed in 6.4 s. This test is flaky without this change
  too, on low: main 43112262620, #105 43114272509 and p3.1b 43110335218 among
  the last ~20 CI runs of other branches. The same test failed both tries in
  c061b67's run.

Other branches' smoke-ride e2e took 5.3–13.1 min in that period (main
8.1–11.1 min).

The head's docs-only commit 85e800d (run 43139743857) went green: 15 passed,
`viewport-1280:96` flaky again. That makes it flaky in 3 of 5 medium runs on
this branch (counting c061b67's), against 3 of ~20 on other branches. The
sample is small, but the rate may be higher here.

To check, cat-bed ran CI's order in one worker (tv-remote, a medium ride, then
viewport-1280) on 2 cores, with no retries, 3 times per build:

| Build | Result | viewport-1280:96 duration |
|---|---|---|
| Gate (5ddd194) | 3/3 passed | 19.0 / 19.1 / 26.8 s |
| Base | 3/3 passed | 22.4 / 18.9 / 17.3 s |

It didn't reproduce, and the test took as long on both builds.

With one frame in flight, the way Home waits at most for the frame on the GPU:
one runner frame, 5.6–6.6 s, minus the time on the finish page.

### The flaky tv-remote run (43134159341 #1)

`tv-remote.spec.ts:116` failed its first try and passed on retry. Right after
the first arrow press in the ride, no `page.evaluate` of the ring check
returned within 5 s. Playwright reports "waiting on the predicate" with no
received value, so the page's main thread didn't answer at all.

It didn't reproduce on cat-bed pinned to 1 core, where SwiftShader takes
4–5 s per frame, close to the runner. The probe pressed ArrowDown when "Pause
ride" showed and timed an evaluate every 100 ms for 25 s
(`frame-gate/main-thread-stalls-1core.jsonl`, `stall_probe.py`):

- Slowest evaluate: 9–54 ms in every run (gate, base, and a 1-frame warm-up
  variant).
- Longest main-thread task: 20–130 ms. None reached 1 s.
- rAF gaps were 3–5 s. That is Chrome not issuing frames while SwiftShader
  holds the core, not a blocked page.

In the traced 1-core runs over 25 s, the page's main thread was busy 482 ms
with the gate (2 % of a core; rAF callbacks 227 ms in total) against 304 ms on
base. The GPU process's main thread was busy 13.5 s against 22.7 s. Holding
frames doesn't make the page burn CPU or block on the GPU. The runner's stall
remains unexplained: 1 test in 4 medium CI runs of the head's code, passed on
retry. tv-remote has failed on low on other branches too (overscan test,
43126212411).

Allowing 1 frame before the GPU is timed (instead of 2) delayed "Pause ride"
from 3.8 s to 12.3 s after the ride URL in the 1-core runs. `ReadySignal`
waits for 2 drawn frames, so the head keeps 2.

### Slower software GL on cat-bed, 5ddd194

| Cores | base Finish → Home | branch Finish → Home | branch in flight, per frame |
|---|---|---|---|
| 4 (3 runs, 10 s ride) | 35.7 / 39.0 / 36.0 s | 0.41 / 0.71 / 0.04 s | 2–3, 1.4–1.5 s |
| 2 (2 runs, 15 s ride) | 64.3 / 69.1 s | 0.59 / 0.27 s | 2, 2.4 s |

In c061b67's run:
- **smoke-ride failed once, then passed on retry.** It read the meter's frame
  count once, right after the ride's distance moved. With the gate, the ride
  runs at the rAF rate while the GPU catches up, so no drawn-frame interval had
  landed yet. The spec now polls for it.
- **viewport-1280's Home test failed twice.** Home's lazy route sections didn't
  mount within 30 s, and the final screenshot shows them in place. This flake
  predates this change (see below). It passed on 5ddd194 in CI, and on cat-bed
  alongside smoke-ride and finish-cover (2 workers, 4 cores) on the gate
  build.

### The same specs on cat-bed

The `tv-remote.spec.ts` + `finish-cover.spec.ts` specs ran at medium on cat-bed:
bundled headless shell, SwiftShader, 4 cores, `--workers=2` (as a 4-vCPU CI
runner). Log: `frame-gate/e2e-medium-headless-shell.log`. Branch build: c061b67.

| | base 0cae127 | branch |
|---|---|---|
| Result | 6 passed (1.5 min) | 6 passed (1.2 min) |
| finish-cover world test | 51.5 s | 27.5 s |
| World Finish → Home (logged) | **32,279 ms** | **48 ms** |
| Frame gate at the second finish | n/a | drawn 10, held 727, 2 in flight, 1.6 s per frame |

Base also passes here, on 4 dedicated cores, but only by waiting 32 s for Home.
CI's shared runners turned that wait into the 15 s+ failures of run
43026470671. With `viewport-1280` + `smoke-ride` + `finish-cover` (2 workers,
4 cores), the branch passed 7/7 in 1.0 min (Home 205 ms) and base passed 7/7 in
2.4 min (Home 44.4 s).

## Real GPU: frame rate unchanged

Measured on c061b67. The head's rule is the same whenever a frame takes
under 3 s of GPU time, so it holds for 5ddd194.

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
(vsync off: branch 5.3–33.2 fps, base 7.7–34.3 fps). The laptop stayed at
load 12–24 from other agents' test runs for the rest of the session, so there
is no idle rerun yet. A rerun on an idle laptop goes on the PR when there is
one.

## Tests

- `frameGate.test.ts` (16): the gate against a simulated in-order GPU, with
  fences seen late. Cases:
  - A fast GPU is never held.
  - Fences 150–900 ms late at 60 fps are never held; a two-frame count loses
    600+ frames.
  - A GPU-bound real GPU keeps the GPU busy.
  - SwiftShader-like 2 s frames are held to 2 in flight.
  - CI-like 6.6 s frames get 1 at a time once timed, and the GPU stays busy.
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
