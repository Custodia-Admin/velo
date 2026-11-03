# tools/render-stream — GPU render-streaming spike

Spike tooling for rendering on cat-bed (RTX 5090) and streaming to household devices over WebRTC.
Findings, numbers, recommended stack and integration sketch: `docs/architecture/STREAMING-SPIKE.md`.

Nothing here is part of the app build. It runs on cat-bed (deployed to `~/velo-stream/`) and on the
laptop (measurement harness).

| File | Runs on | What it does |
| --- | --- | --- |
| `setup.sh` | cat-bed, once | pins and pulls the Selkies image, creates `auth.conf` (0600, never committed) and `rtc.json` (no STUN/TURN), patches Selkies to bind 127.0.0.1, adds the tailnet-only `:8443` listener |
| `run-selkies.sh` | cat-bed | one session container (Xvfb on the GPU, Chrome, NVENC, WebRTC). Takes resolution, fps, display and encoder |
| `demo-up.sh` / `demo-down.sh` | cat-bed | bring a session up with the synthetic GPU scene or the Velo demo ride; tear everything down (velo-web and `:443` untouched) |
| `relay.py` | cat-bed | state relay (`/ws`, rooms, presence, clock ping, `reports.jsonl`), `/health`, serves `www/` |
| `kiosk/` | in the container | kiosk render Chrome, headless client Chrome, Cesium `sampleHeight` memo (diagnostic) |
| `www/` | browser | `client.html` + `measure.js` (client: stream player + 20 Hz state uplink + input-echo latency), `render-agent.js` (render side: marker + relay), `gpu-scene.html` (synthetic GPU load), `pc-hook.js` (WebRTC stats) |
| `run_case.sh`, `run_dual.sh`, `client_measure.py`, `server_*.py`, `render_stats.py`, `host_sample.sh` | laptop (+ cat-bed) | the measurement harness used for the numbers in the doc |
| `profile_render.py`, `callers.py`, `inclusive.py`, `gpu_evidence.py`, `ws_rtt.py` | laptop | CPU profile of the render page, chrome://gpu evidence, WebSocket RTT |

Constraints: no BLE (the server only runs demo mode); tailnet only; images pinned by digest.
