#!/usr/bin/env python3
"""P3.2 acceptance: the frame stays <= 16 ms with the play layer on (measured once).

Rides Tiber river park on the world renderer (fake KICKR at 142 W, no
hardware) twice in one browser: play layer ON (Play mode + Anna's ghost, her
last ride stored first) and OFF (Play mode off, ghost "No ghost"). Per run:
settle 6 s, then the RAF frame intervals over WIN_S seconds, the renderer's
own FrameStats (window.__veloRideDebug) and the ride store's tick() time
(wrapped in place: the per-frame ride step the trainer loop runs).

    BASE=http://127.0.0.1:5197 uv run --with playwright --with pillow python scripts/play-layer-perf.py

Env: VP=1440 (common.VIEWPORTS key)  WIN_S=12  ROUNDS=2
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "v2-build-shots"))
import common  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

VP = os.environ.get("VP", "1440")
WIN = float(os.environ.get("WIN_S", "12"))
ROUNDS = int(os.environ.get("ROUNDS", "2"))
ROUTE = "scenic-perugia-tiber-park"
spec = __import__("importlib.util").util.spec_from_file_location("pl", Path(__file__).resolve().parent / "v2-build-shots/play-layer.py")
pl = __import__("importlib.util").util.module_from_spec(spec)
spec.loader.exec_module(pl)  # type: ignore[union-attr]

MODE = {
    "on": "localStorage.setItem('globeride.settings.v1', JSON.stringify({state:{playMode:true}, version:1}));"
          "localStorage.setItem('globeride.velo.coupleGhost.v1', JSON.stringify({state:{choice:'last'}, version:0}));",
    "off": "localStorage.setItem('globeride.settings.v1', JSON.stringify({state:{playMode:false}, version:1}));"
           "localStorage.setItem('globeride.velo.coupleGhost.v1', JSON.stringify({state:{choice:'off'}, version:0}));",
}

WRAP_TICK = """async () => {
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  const st = useRideStore.getState();
  if (st.__tickWrapped) return 'already';
  const orig = st.tick, ms = [];
  window.__tickMs = ms;
  useRideStore.setState({ tick: (...a) => { const t0 = performance.now(); const r = orig(...a); ms.push(performance.now() - t0); return r; }, __tickWrapped: true });
  return 'wrapped';
}"""

MEASURE = """async (secs) => {
  window.__tickMs.length = 0;
  const ts = []; const t0 = performance.now();
  await new Promise(res => { function f(t) { ts.push(t); if (t - t0 < secs * 1000) requestAnimationFrame(f); else res(); } requestAnimationFrame(f); });
  const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]); d.sort((a, b) => a - b);
  const tk = [...window.__tickMs].sort((a, b) => a - b);
  const q = (a, p) => a.length ? Math.round(100 * a[Math.min(a.length - 1, Math.floor(a.length * p))]) / 100 : null;
  const { useCoupleGhostStore } = await import('/src/stores/coupleGhostStore.ts');
  const { usePlayStore } = await import('/src/stores/playStore.ts');
  const dbg = window.__veloRideDebug?.() ?? {};
  return { fps: Math.round(10 * (ts.length - 1) * 1000 / (ts[ts.length - 1] - ts[0])) / 10, frameP50: q(d, 0.5), frameP95: q(d, 0.95), frameWorst: q(d, 1),
    over17: Math.round(1000 * d.filter(x => x > 17).length / d.length) / 10,
    tickN: tk.length, tickP50: q(tk, 0.5), tickP95: q(tk, 0.95), tickWorst: q(tk, 1),
    renderer: { fps: dbg.fps, avgMs: dbg.avgMs, p95Ms: dbg.p95Ms, drawCalls: dbg.drawCalls },
    ghost: !!useCoupleGhostStore.getState().ghost, postcards: usePlayStore.getState().total };
}"""


def main() -> None:
    results: dict = {"vp": VP, "win_s": WIN, "runs": []}
    with sync_playwright() as p:
        browser = common.launch(p)
        for r in range(ROUNDS):
            for mode in ("on", "off") if r % 2 == 0 else ("off", "on"):
                ctx, page = common.new_page(browser, VP, "day", pl.ROSTER + MODE[mode], fake={"granted": True})
                try:
                    pl.start_ride(page, VP)
                    page.evaluate(WRAP_TICK)
                    time.sleep(6)
                    m = page.evaluate(MEASURE, WIN) | {"mode": mode, "round": r}
                    results["runs"].append(m)
                    print(json.dumps(m), flush=True)
                except Exception as e:
                    print("FAIL", mode, str(e)[:300], flush=True)
                ctx.close()
        browser.close()
    out = common.REPO / "docs/design/screenshots/v2/build/play-layer/perf.json"
    out.write_text(json.dumps(results, indent=1))
    print(out)


if __name__ == "__main__":
    main()
