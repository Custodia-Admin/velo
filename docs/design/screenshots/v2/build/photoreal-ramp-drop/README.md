# Photoreal: the nearest drawn tile is the ground, not pick's first tile (card t_5649bf24)

Each image has two panels: **#91 48f92c5 (`index-Dqtteiv9.js`) | this PR (`index-D4-K-BQP.js`)**, shot by `pr76probe.py` on cat-bed (Intel iGPU via ANGLE GL-EGL) on 6 Nov 2026, both builds in the same session, on the ramp onto the Chengdu Luxe Lakes bridge at 1264 m. Probe and queues: `~/.hermes/handoffs/velo/t_5649bf24/` (`q2.sh`, `q4.sh`, output `cat/q2`, `cat/q4`).

The drop this PR fixes lasts one ground sample (about 0.3 s). Playwright's screenshot lands after the next sample, when the rider is already back on the ramp. A shot taken right after a drop sample shows the rider on the ramp in both builds (`chA8-*-at1260.png` in the handoff, mean pixel difference 2.2 out of 255). The drop is measured from the probe's numbers instead (see the PR).

| file | what it shows |
|---|---|
| `chengdu-1264-1280x648.jpg` | 1280×648@2 (the owner's tab). The same frame on both builds (mean pixel difference 3.3 out of 255: clouds and time of day). |
| `chengdu-1264-1440x900.jpg` | 1440×900@1, the same (0.3 out of 255). |
| `chengdu-1264-390x844.jpg` | 390×844@3, the same (2.7 out of 255). |

Sizes are scaled to CSS px.
