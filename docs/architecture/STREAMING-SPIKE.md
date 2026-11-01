# Streaming spike: render on cat-bed, stream to the devices

Status: spike, 31 Oct 2026. Kanban t_fcc1b1a4. Input for Fable consult #2, which folds
streaming into the v2 phases. Tooling: `tools/render-stream/`. Raw results:
`~/velo-stream/samples/` on cat-bed plus the `result-*.json` files described under
[How to reproduce](#how-to-reproduce).

## Verdict

| Bar | Result |
| --- | --- |
| 1080p60 stable | **Pass for the pipeline.** A GPU-heavy WebGL scene renders, encodes on NVENC and arrives at 60 fps, with 0 packet loss, a 2.6 % NVENC load and 16 % GPU. 1440p60 and AV1 1080p60 hold too. **Fail for today's Velo ride.** The Cesium ride renders only 15–20 fps on the 5090 because its JS main thread is saturated. The GPU is not the limit (follow-up t_0bf516d2). |
| < 80 ms glass-to-glass on LAN | **Not met reliably.** State→display on cat-bed loopback is p50 62–90 ms per run at 1080p60 (AV1 75 ms, 1440p 90 ms). LAN adds about 5–10 ms and the panel 5–15 ms. Expected LAN glass-to-glass on a client that can decode: about 75–115 ms. **Closest setting:** 1080p60, AV1 or H.264, one session, CPU kept out of deep idle (p50 62 ms loopback). |
| Laptop client | **Fail on this ThinkPad.** Chrome decodes WebRTC H.264 in software here (19–47 ms per frame), so 1080p60 backs up the jitter buffer by seconds. The CPU is also heavily thermal-throttled (see [The laptop](#the-laptop-as-a-client)). The best frames still arrived 70–85 ms after the state was sent. |
| Android / tablet client | **Not measured.** The only Android device on the tailnet (Oppo Find N6) was dozing behind a secure lock screen, and agents can't unlock it. A 2-command owner test is below; results land on cat-bed automatically. |
| 2 concurrent household streams | **Feasible.** Two 1080p60 sessions: GPU 46 % average (79 % peak on the heavy shader), NVENC 8–11 %, about one CPU core and about 0.6 GB VRAM per session. |

**Recommendation.** Keep the split-plane design. Build streaming on Selkies 2.1 (NVENC, WebRTC, zero-copy
Xvfb capture), one container per concurrent stream, tailnet-only. Hide the world-video lag with
predicted-pose rendering on the server (see [Integration sketch](#integration-sketch)). Do two things first,
because each one alone defeats streaming today:
1. Fix the Cesium ride's main-thread budget, or stream the three.js world renderer instead.
2. Make sure each target client has hardware WebRTC decode: Android/Chromecast/Android TV via MediaCodec
   do. Desktop Chrome on Linux did not, in this test.

## Setup that was measured

- **Server.** cat-bed: Intel Core Ultra 9 290HX Plus (8P + 16E), 188 GB RAM, RTX 5090 Laptop 24 GB, driver
  615.78.08, CachyOS, Docker with nvidia-container-toolkit 1.20.1. llama-server holds 10.7 GB VRAM. The
  measurements ran alongside it and alongside up to 12 `sentinel-ci` qemu VMs at nice 9, so they are
  conservative. velo-web (nginx, :4180) and the :443 tailscale serve were never touched.
- **Stack.** Selkies 2.1.0 desktop image, pinned by digest
  `ghcr.io/selkies-project/selkies/desktop@sha256:558fb9d6…1aec2e`. Inside it:
  - Xvfb with glamor/DRI3 on the 5090.
  - Google Chrome 156 kiosk rendering the page.
  - pixelflux zero-copy capture → NVENC (H.264 constrained baseline, `profile-level-id=42001f`, or AV1) → WebRTC (vendored aiortc), CBR 20 Mbit/s, congestion control off.
- **Network.** The laptop is on Wi-Fi 192.168.0.0/24 (5.6 GHz, 160 MHz, −55 dBm, power-save on). cat-bed is
  on 2.5 GbE 192.168.8.0/24 behind a second router (WAN side 192.168.0.4). This is not one L2 LAN: the
  laptop cannot reach 192.168.8.240 directly. Tailscale goes direct through 192.168.0.4 (no DERP).
  - ICMP over the tailnet: min 3.0, avg 7–9, max 19–27 ms. Wi-Fi alone: 1.4 / 7.3 / 38 ms to the laptop's own gateway.
  - WebSocket RTT to the relay, idle: p50 9.4, p95 23.4 ms (n=200).
  - WebRTC picked host candidates on the tailnet addresses (`100.81.41.68` / `fd7a:…`). No STUN, no TURN; the ICE server list is empty.
- **Exposure.** Selkies is bound to 127.0.0.1 (the image hard-codes `--public`, so setup patches its
  entrypoint) and published with `tailscale serve --https=8443` (tailnet only, basic auth). The relay is on
  127.0.0.1:8095, published as `/velo-relay` on the same origin. WebRTC media uses UDP host candidates.
  Nothing is forwarded on the router.

### GPU evidence (chrome://gpu in the render Chrome)

```
GL_RENDERER : ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 5090 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 615.78.08)
GL implementation parts : (gl=egl-angle,angle=opengl)
WebGL: Hardware accelerated · WebGL2: Hardware accelerated · WebGPU: Hardware accelerated
Rasterization: Hardware accelerated on all pages · Compositing: Hardware accelerated
WEBGL_debug_renderer_info: ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 5090 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0)
```
Xvfb log: `glamor(0): DRI3 X acceleration enabled on NVIDIA GeForce RTX 5090 Laptop GPU`,
`vfb: screen pixmap is on the GPU`. pixelflux: `Render node 1 encodes H264, AV1, H265 on nvenc`.
SwiftShader is not involved.

Getting there needed one host-specific fix. nvidia-container-toolkit 1.20.1 does not inject NVIDIA's GBM
backend (`libnvidia-allocator`). Without it, Selkies' probe reports `unusable: Failed to allocate GBM buffer`
and the session falls back to GL through Zink with a CPU readback into a software framebuffer.
`run-selkies.sh` bind-mounts the host's allocator as both `libnvidia-allocator.so.1` and
`gbm/nvidia-drm_gbm.so`.

## Method

**Input-echo, the split-plane path itself.** The client page sends ride state over the WebSocket at 20 Hz.
Each message carries a `seq` and the client's send time (`performance.timeOrigin + now()`), and goes
client → tailscale serve → relay → render page.

The render page applies the state and paints `seq & 255` as an 18-block marker in the top-left corner:
32 device-px blocks, white and black calibration, 8 bits, then the 8 complement bits as a check.

On the client, `requestVideoFrameCallback` reads the marker out of every decoded frame. Latency =
`expectedDisplayTime` of the first frame showing that `seq`, minus the send time. Both timestamps come
from the client clock, so no clock sync is needed.

What the number covers:
- Uplink, then the wait for the next render frame.
- Chrome's compositor, X present, capture, NVENC, packetisation, network, jitter buffer and decode.
- The client compositor's presentation estimate.

What it does not cover: panel scan-out and response (add about 5–15 ms on a monitor; TVs outside game mode
add 30–100 ms), and the BLE → sim input path, which stays local by design.

Breakdowns:
- `toRecv`: send → RTP receive of that frame.
- `uplink`: send → applied in the render page, with a ping/pong clock offset.
- WebRTC `getStats()`: decode time, jitter buffer, loss.

Server side: `nvidia-smi` (GPU, NVENC, power) and `docker stats` once per second.

**Loopback runs.** The client is a second headless Chrome on cat-bed, using the same https URL through
tailscale serve. These isolate the server pipeline from Wi-Fi and from the laptop's decoder.

**Sources:**
- The real Velo demo ride (production build, scenic-perugia-tiber-park, HUD hidden by CSS).
- `www/gpu-scene.html`: a raymarched fBm terrain fly-over standing in for a GPU-heavy world renderer. It moves the full frame, which is the encoder's worst case, and costs little CPU.

## Results

### Loopback (server pipeline + decode, no network)

| Case | Stream | Delivered fps | Intervals > 25 ms | State→display p50 / p95 (min) ms | Send→frame received p50 | GPU % | NVENC % | Container CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GPU scene, H.264, run 1 | 1080p60 | 59.8 | 0.5 % | 79.0 / 80.0 (62.2) | 51.1 | 15.6 | 2.7 | 97 |
| GPU scene, H.264, run 2 | 1080p60 | 59.6 | 0.9 % | 84.7 / 85.3 (83.9) | 59.6 | 16.1 | 2.7 | 103 |
| same, 2 cores kept busy | 1080p60 | 56.3 | 24 % | **61.8** / 78.8 (45.1) | 46.7 | 15.4 | 2.5 | 111 |
| GPU scene, **AV1** | 1080p60 | 60.0 | 0.3 % | 74.6 / 75.1 (57.4) | 47.8 | 15.5 | 2.6 | 159 |
| GPU scene, H.264 | **1440p60** | 59.5 | 1.0 % | 89.8 / 90.4 (84.5) | 80.6 | 44.7 | 4.9 | 172 |
| **Two sessions**, A | 1080p60 | 51.1 | 20 % | 37.0 / 53.8 (35.1) | 35.2 | 46 (peak 79) | 8.3 (peak 11) | 99 |
| **Two sessions**, B | 1080p60 | 59.5 | 7 % | 43.7 / 44.3 (25.5) | 27.5 | ″ | ″ | 110 |
| **Velo demo ride** (Cesium) | 1080p60 | 58.4 (15 unique) | 15 % | 171.9 / 238.6 (72.4) | 156.1 | 10.6 | 2.5 | 283 |

Notes:
- Server render fps: 60.0 steady in every GPU-scene run (frame p99 16.8 ms). The Velo ride runs at
  15 fps (frame p50 66.7 ms), so Selkies sends repeats of the same image.
- NVENC encode latency (`nvidia-smi encoder.stats.averageLatency`): 1.6–2.1 ms at 1080p,
  2.6–3.5 ms at 1440p. nvidia-smi reports no encoder stats for AV1, but the stream ran at 60 fps.
- **Variance.** One-session runs settle on a near-constant delay per run (p50 ≈ p95), but that delay
  differs between runs: 62–85 ms at 1080p60. Keeping two cores busy lowered it, and the two-session run
  was lower still (37–44 ms). Both point at frame-phase alignment between three free-running 60 Hz clocks
  (Chrome on Xvfb, pixelflux capture, client vsync), plus CPU idle states on the many hand-offs. A first
  two-session run gave a physically impossible 8 ms minimum on one side and was discarded; its other side
  read 104.5 ms.
- Treat the ranges as the honest answer, and pin the deployment: performance governor or `cpu_dma_latency`
  on cat-bed, and a capture triggered by Chrome's present instead of a timer.
- `--disable-gpu-vsync --disable-frame-rate-limit` on the render Chrome breaks capture. It renders about
  600 fps at 100 % GPU and the stream freezes. Keep vsync on.

### The laptop as a client

Wi-Fi to tailnet, Chrome 154, headless, Xvfb and headed Wayland all tried:

| Case | Decoder ms / frame (WebRTC stats) | Decoded fps | Jitter buffer avg | State→display min | p50 |
| --- | --- | --- | --- | --- | --- |
| GPU scene 1080p60 | 19.2 | 45 | 1.1 s | 84.9 ms | 1.5 s (backlog) |
| GPU scene 1080p30 | 39.2 | 27 | 2.3 s | 316 ms | 3.4 s |
| GPU scene 720p60 | 21.9 | 16 | 1.8 s | 209 ms | 2.2 s |
| Velo ride 1080p30 | 39.2 | 25 | 1.6 s | 297 ms | 2.1 s |

- The decode is software in every flag set tried. With ANGLE on Vulkan, chrome://gpu lists no decode
  profiles. With `--use-angle=gl --enable-features=AcceleratedVideoDecodeLinuxGL` it lists hardware H.264
  for `<video>`, but WebRTC decode time stayed about 30 ms per frame.
- The decode cost does not scale with resolution (720p ≈ 1080p). That points at CPU starvation. During the
  runs the package was at 82 °C, the per-core `thermal_throttle` counters were in the hundreds of millions,
  and baloo indexing was taking about 75 % of a core.
- This also feeds the laptop's local-render stutter. It is reported as a fact, not to re-open that
  decision.
- The minimum latencies (70–85 ms) show what the laptop would reach with a decoder that keeps up: the
  network adds only about 5–10 ms over loopback.

### Velo ride on the server: why 15–20 fps on a 5090

A CDP CPU profile of the render page (5 s, demo ride) found:
- The main thread is at 100 % of one core.
- The Cesium render loop is 62 % inclusive.
- `readPixels` is 19 % self. Every call is `Scene.sampleHeight`, a pick pass plus a synchronous GPU readback, called by the avatar update on every preRender.
- The GPU sits at 7–25 %.

Memoising `sampleHeight` at runtime (5 m grid, 1 s TTL; `kiosk/sample-memo.js`) only lifts it from 16 to
20 fps. The rest is spread over entity updates, recharts (the hidden HUD still renders) and GC.

The saturated main thread also delays incoming state: uplink p50 84 ms against 0.2 ms on the light page.
A render page on the server must therefore be a **world-only route** (no HUD, no charts) with a lean
per-frame budget. Follow-up card: t_0bf516d2.

## Recommended stack

1. **Selkies 2.1.0 desktop image, pinned by digest**, one container per concurrent stream (`--network host`,
   `--runtime nvidia`, own X display `:20`, `:21`, …). It is turnkey and has the right internals: zero-copy
   NVENC, WebRTC with a pacer and FEC, codec ladder H.264 → AV1, H.265.
   Settings we rely on:
   - `SELKIES_MODE=webrtc`, an empty `iceServers` list, encoder `h264enc` (AV1 where the client decodes it in hardware).
   - CBR 20 Mbit/s with congestion control off on the LAN.
   - DPI locked at 96. Otherwise Selkies rescales the page to 120 DPI at 1440p.
   - Audio, clipboard, files and printing off.
   - Loopback bind, published only through `tailscale serve`.
2. **Render page** = the Velo app at a world-only route, driven by the incoming state through the existing
   `WorldRenderer.setRider()` seam. No CDP or Playwright in production; CDP was spike-only.
3. **Relay** = a small WebSocket service on cat-bed. The spike's `relay.py` (aiohttp) already does rooms,
   presence, clock ping and report logging. It grows into the session manager: start/stop containers, idle
   timeout.
4. **Not recommended now:**
   - Raw GStreamer `webrtcbin`. cat-bed has gst 1.28 with `nvcodec` and `webrtc`, but it means writing
     signalling, capture and congestion handling ourselves for no measured gain.
   - TURN or any public exposure.
5. **Worth one more experiment** (Fable #2 to decide): the render page publishes its own canvas with
   `canvas.captureStream()` → `RTCPeerConnection` straight to the client over our relay. This removes X
   capture and Selkies, and we own both signalling ends, so it has fewer hops and likely lower latency.
   The catch: Chrome on Linux reports "Video Encode: Software only", so the encode would be CPU
   OpenH264/libvpx, not NVENC. Fine at 1080p60 on 24 cores, untested here.

## Integration sketch

Split planes, as the card asks:

```
client (laptop / tablet / TV)                         cat-bed
┌───────────────────────────────┐   pose 20 Hz (WSS)   ┌──────────────────────────────┐
│ FTMS + handlebars (Web BT)    │ ───────────────────▶ │ relay / session manager      │
│ rideFsm + rideSim (pure)      │ ◀─── presence/acks ── │   └▶ render page /render     │
│ DOM HUD (local, 0 ms)         │                      │      WorldRenderer.setRider  │
│ RemoteVideoWorldView <video>  │ ◀═══ WebRTC video ══ │      Chrome → NVENC (Selkies)│
└───────────────────────────────┘                      └──────────────────────────────┘
```

### RemoteVideoWorldView (implements the P1.2 seam)

`src/lib/world/renderer.ts` already has the right shape. `setRider`, `setCamera` and `setMood` become
messages, and the renderer the server runs is still `'world'` or `'photoreal'`. Remote is a *placement*,
not a third kind. So, in the next phase (not in this PR):

```ts
// src/stores/settingsStore.ts
renderHost: 'local' | 'remote';            // orthogonal to `renderer`
remoteRenderUrl: string;                   // e.g. https://cat-bed.tail6f8715.ts.net:8443

// src/renderers/registry.ts — RideView picks the remote view when renderHost === 'remote'
// and the health check passes, otherwise the local loader for `renderer`.

// src/renderers/remote/RemoteVideoWorldView.tsx
export function RemoteVideoWorldView({ onReady }: WorldViewProps) {
  // 1. open the session: WSS {remoteRenderUrl}/velo-relay/ws?role=client&room=<sessionId>
  //    send hello { v:1, renderer, routeId, viewport:{w,h,dpr}, codecs }
  // 2. attach video: a <video muted playsinline> filled with the session's MediaStream
  //    (spike: hidden same-origin Selkies iframe; product: our own signalling)
  // 3. subscribe to the ride store / rideSim output and send `pose` at 20 Hz
  // 4. onReady(renderer) after the first video frame (requestVideoFrameCallback)
  // 5. on failure → props.onFallback() and RideView mounts the local renderer
}

function createRemoteWorldRenderer(ch: RemoteChannel, kind: RendererKind): WorldRenderer {
  return {
    kind,
    setRider: (pose) => ch.send({ t: 'rider', pose }),        // null = back to live poses
    setCamera: (mode) => ch.send({ t: 'camera', mode }),
    setMood: (mood) => ch.send({ t: 'mood', mood }),
    dispose: () => ch.close(),                                 // idempotent
  };
}
```

Server side, the render page is the Velo app at `/render?session=…&renderer=world|photoreal`. It mounts
the chosen view without the HUD, and on each `pose` calls
`renderer.setRider(predict(pose, latencyBudget))`, plus `setCamera`/`setMood` on those messages.

### State-sync protocol v1

JSON over WSS through `tailscale serve` (same origin as the stream). `room` = session id.

| Direction | Message | When |
| --- | --- | --- |
| C→S | `hello {v, session, renderer, routeId, viewport, codecs}` | on connect; server loads the route, answers `ready` |
| C→S | `pose {seq, at, pose: RiderPose, cam, mood?}` | 20 Hz while riding; 2 Hz keep-alive when paused; immediately on camera/mood change |
| C→S | `ping {c0}` → S→C `pong {c0, s}` | 1 Hz; clock offset from the lowest-RTT sample |
| S→C | `ready {firstFrameAt}` / `applied {seq, s}` (sampled 2 Hz) / `error {code}` | telemetry gives the measured pipeline latency |
| relay | `presence {role, up}` | renderer up/down, used for fallback |

- **Rate and size.** 20 Hz × about 200 B JSON ≈ 4 kB/s. The 32-byte `multiriderCodec` frame could carry the
  pose if needed. 20 Hz is plenty because the server interpolates.
- **Latency hiding.** The server renders the pose extrapolated by the measured pipeline latency (pose `at`
  + clock offset + rolling p50 of `applied`→frame). At 30 km/h, 90 ms is 0.75 m of road. Speed and heading
  are smooth, so dead reckoning hides it, and only discrete events (camera switch, lane change) show the
  delay. The HUD, the numbers and trainer resistance never wait for the server.
- **Reconnect.** WebSocket backoff 0.5 → 1 → 2 → 5 s, re-sending `hello` and the last pose. Video uses an
  ICE restart, then a full renegotiation after 5 s. The ride never pauses for the renderer.
- **Fallback to local render.**
  - Health check `GET /velo-relay/health` (800 ms timeout) before the ride. If it fails, mount the local renderer.
  - Mid-ride: if no video frame arrives for 1.5 s or presence reports the renderer down, mount the local
    renderer at the current pose. Show a quiet "Local render" chip, which needs design-gate approval.
  - Retry remote every 30 s, and switch back only at a pause or after 10 s of stable frames, to avoid flapping.
  - Keep the local renderer chunk prefetched while remote is active.
- **Sessions.** One container (Chrome + NVENC session) per concurrent client. The relay starts one on
  `hello` from a warm pool of one, and stops it 2 min after the last client leaves. A full 1080p60 session
  costs about 1 core, about 300–600 MB VRAM and 2–3 % NVENC, so the household's 2–3 streams fit next to
  llama-server.
- **Security.** Tailnet only. Replace the shared basic auth with Selkies secure-mode per-session tokens
  that the relay mints.

## Open questions for Fable consult #2

1. Phase placement. Streaming needs a lean world-only render route, and the Cesium path is main-thread
   bound. Does remote rendering wait for P1.4 (three.js world), or does the Cesium perf fix (t_0bf516d2)
   come first?
2. Video path: keep Selkies with its iframe signalling, write a direct client for Selkies' signalling, or
   own both ends with `canvas.captureStream()` WebRTC (software encode)? Needs one latency run on the
   same harness.
3. Client matrix. Hardware WebRTC decode is the gate. Test Android tablet, Chromecast/Google TV and the
   ThinkPad with Windows/ChromeOS-class drivers, and decide whether desktop Linux clients are supported
   at all.
4. Is a 75–115 ms world lag (hidden by prediction) acceptable for the owner, or is < 80 ms a hard
   requirement? If hard: present-driven capture, CPU latency tuning and a desynchronized canvas need
   their own packet.

## How to reproduce

On the laptop, from the repo root:

```bash
rsync -a tools/render-stream/ cat-bed:velo-stream/
ssh cat-bed 'bash ~/velo-stream/setup.sh'                       # once: secret, rtc.json, entrypoint patch, tailnet :8443
ssh cat-bed 'bash ~/velo-stream/demo-up.sh gpu 1920 1080 60'     # or: demo-up.sh velo | … 2560 1440 60 | … av1enc
# client:  https://cat-bed.tail6f8715.ts.net:8443/  (log in: ubuntu / password in cat-bed:~/velo-stream/auth.conf)
#          then https://cat-bed.tail6f8715.ts.net:8443/velo-relay/client.html  — HUD shows fps/latency;
#          every 5 s a report is appended to cat-bed:~/velo-stream/reports.jsonl (with the user agent)
ssh cat-bed 'bash ~/velo-stream/demo-down.sh --serve'            # stop containers + relay, drop :8443/:8445
```

Measurement harness (laptop, `cd tools/render-stream`; needs `ssh -L 9223/9224/9230/9231` tunnels to cat-bed):
- `bash run_case.sh <label> <W> <H> <FPS> gpu|velo <secs> catbed|laptop` runs one case. `ENC=av1enc`
  switches the codec; `BUSY=1` keeps two cores busy.
- `bash run_dual.sh <label> 1920 1080 60 30 gpu gpu` runs two concurrent sessions.
- Each run writes `result-<label>.json` (client series + raw latencies) and `host-<label>.txt`
  (nvidia-smi/docker summary).
- `profile_render.py`, `callers.py` and `inclusive.py` reproduce the Cesium CPU profile.
- `gpu_evidence.py` dumps chrome://gpu.

**Android/TV test (owner, about 2 min).** Run `demo-up.sh gpu`. On the tablet, open the two URLs above
and keep the screen on for 60 s, then run `demo-down.sh --serve`. The device's numbers land in
`reports.jsonl`.
