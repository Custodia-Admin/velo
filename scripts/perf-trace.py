"""Chrome trace of the ride view: where wall time goes per thread.

Starts a Demo Mode ride, waits SETTLE_S, records a TRACE_S Chrome trace and
prints busy % per thread (renderer main, compositor, GPU main, workers) and
the top task names on the renderer main and GPU main threads.

Usage: uv run --with playwright python scripts/perf-trace.py <out.json> [base] [route-id]
Env: VIEW=1080|1600, QUALITY, SETTLE_S (20), TRACE_S (6), HEADLESS=1 (default 1)
"""
import collections, json, os, pathlib, sys
from playwright.sync_api import sync_playwright

out = pathlib.Path(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4173"
route_id = sys.argv[3] if len(sys.argv) > 3 else "scenic-lugano-melide"
VIEW = os.environ.get("VIEW", "1080")
QUALITY = os.environ.get("QUALITY")
SETTLE_S = float(os.environ.get("SETTLE_S", "20"))
TRACE_S = float(os.environ.get("TRACE_S", "6"))
GPU = ["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"]
VIEWPORTS = {
    "1080": dict(viewport={"width": 1920, "height": 1080}, device_scale_factor=1),
    "1600": dict(viewport={"width": 1463, "height": 914}, device_scale_factor=1.75),
}
state = {"liveWeatherEnabled": False, **json.loads(os.environ.get("EXTRA_LS", "{}"))}
if QUALITY:
    state["graphicsQuality"] = QUALITY
INIT = """
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));
localStorage.setItem('globeride.settings.v1', JSON.stringify({state:%s,version:1}));
""" % json.dumps(state)
CATS = "devtools.timeline,disabled-by-default-devtools.timeline,gpu,toplevel,v8,blink,cc,viz,disabled-by-default-devtools.timeline.frame"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/sbin/chromium", headless=os.environ.get("HEADLESS", "1") == "1", args=GPU)
    ctx = b.new_context(**VIEWPORTS[VIEW], color_scheme="dark", service_workers="block")
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    for asset in filter(None, os.environ.get("BLOCK_ASSETS", "").split(",")):
        pg.route(f"**/v1/assets/{asset}/endpoint**", lambda route: route.abort())
    pg.goto(f"{base}/app", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_selector(f"[data-scenic-route='{route_id}']", timeout=30000)
    pg.evaluate(f"() => document.querySelector(\"[data-scenic-route='{route_id}']\").click()")
    pg.wait_for_url("**/ride**", timeout=20000)
    pg.wait_for_timeout(int(SETTLE_S * 1000))
    b.start_tracing(page=pg, path=str(out), categories=CATS.split(","))
    pg.wait_for_timeout(int(TRACE_S * 1000))
    b.stop_tracing()
    b.close()

tr = json.loads(out.read_text())
ev = tr["traceEvents"] if isinstance(tr, dict) else tr
names = {}
for e in ev:
    if e.get("ph") == "M" and e.get("name") == "thread_name":
        names[(e["pid"], e["tid"])] = e["args"]["name"]
ts = [e["ts"] for e in ev if "ts" in e and e.get("ph") in ("X", "B", "E")]
span = (max(ts) - min(ts)) / 1e3 if ts else 1
busy = collections.Counter()
by_name = collections.defaultdict(collections.Counter)
for e in ev:
    if e.get("ph") != "X" or "dur" not in e:
        continue
    th = names.get((e["pid"], e["tid"]), str(e["tid"]))
    if e.get("name") in ("ThreadControllerImpl::RunTask", "RunTask"):
        busy[th] += e["dur"] / 1e3
    by_name[th][e["name"]] += e["dur"] / 1e3
print(f"trace span {span:.0f} ms")
for th, ms in busy.most_common(14):
    print(f"  {th:28s} busy {ms:7.0f} ms ({100 * ms / span:5.1f} %)")
for th in ("CrRendererMain", "CrGpuMain", "VizCompositorThread", "Compositor"):
    print(f"-- {th} top events (inclusive ms)")
    for n, ms in by_name[th].most_common(18):
        print(f"     {ms:7.0f}  {n}")
frames = [e for e in ev if e.get("name") in ("BeginFrame", "DrawFrame", "Graphics.Pipeline", "PipelineReporter") and e.get("ph") in ("X", "b", "n", "I")]
print("frame-ish events:", collections.Counter(e["name"] for e in frames))

# Longest main-thread tasks and what ran inside them.
main = [k for k, v in names.items() if v == "CrRendererMain"]
gpu = [k for k, v in names.items() if v == "CrGpuMain"]
def kids(task, pid_tid):
    t0, t1 = task["ts"], task["ts"] + task["dur"]
    c = collections.Counter()
    for e in ev:
        if e.get("ph") == "X" and (e["pid"], e["tid"]) == pid_tid and t0 <= e["ts"] < t1 and e is not task and "dur" in e:
            c[e["name"]] += e["dur"] / 1e3
    return c.most_common(8)
for label, keys in (("renderer main", main), ("gpu main", gpu)):
    tasks = sorted((e for e in ev if e.get("ph") == "X" and (e["pid"], e["tid"]) in keys and e.get("name") == "ThreadControllerImpl::RunTask"), key=lambda e: -e["dur"])[:6]
    print(f"== longest {label} tasks")
    for t in tasks:
        print(f"  {t['dur']/1e3:7.1f} ms  at {(t['ts']-min(ts))/1e3:7.0f}")
        for n, ms in kids(t, (t["pid"], t["tid"])):
            print(f"        {ms:7.1f}  {n}")
