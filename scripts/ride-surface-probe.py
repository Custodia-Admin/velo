"""Ride-surface probe: the rider stands on the ground that is drawn, and only one road surface is ever seen.

Owner report 4 Nov 2026 (Trasimeno shore, photoreal): two copies of the road stacked a few metres apart,
the rider on the lower one under the terrain. This rides each route from the Home card (the ride starts
itself, as the owner's did), samples the start, then holds the rider at each spot and measures, against the
surfaces the renderer really draws:

  world (three.js)  a vertical ray through every drawn mesh at the rider (terrain chunks, road ribbons, route
                    line; instanced trees/buildings and the rider itself excluded).
  photoreal (Cesium) the globe's terrain where the globe draws opaque, and the Google photoreal mesh where it
                    shows (both depth-tested: the higher one is what you see), at the rider and at the camera.

Held spots fail outside +-TOL; ridden start samples fail only when under a drawn surface (rider or camera) and
report the rest (float, pop) as soft counts. A sample is ok when |rider - top drawn ground| <= TOL, nothing drawn sits more than TOL above the wheels and
the camera is above every drawn surface under it. A photoreal mesh reading 2.5 m or more over the wheels is an
overhang (tree, lamp, bridge: the mesh height is the top of whatever is there) and is counted, not failed; the
globe is bare terrain and never exempt. A rider more than 6 m over the opaque bare terrain is "on a structure"
(canopy, viaduct deck: one top-of-mesh ray cannot see the ground below it); held samples there are counted
apart unless something drawn is over the wheels or the camera; so are held samples under an overhang with the
rider within 2 m over the bare terrain (the road under a viaduct deck is invisible to the probe). Ridden samples also fail on a pop: the rider's height jumping more than
0.5 m + 30 % of the distance between two samples. Road surfaces: on the world renderer the road-ribbon and
route-line hits in the rider's column form ONE level (hits within TOL of each other). On photoreal the road
is a ground classification painted on whichever surface is in front, so exactly one copy shows when the
camera is above every drawn surface; a camera under the globe sees its underside, road and all, as a
ceiling over the road it rides (the owner's two roads). Exits 1 on any failure. Needs a build with the
scene handles (localStorage velo.debug.three / velo.debug.cesium).

usage: uv run --with playwright python scripts/ride-surface-probe.py <out> <base> [route-id,...]
env: SPOTS=1000,3000,5000 (held, metres; reached by rolling in over the last 60 m)  START_M=100 (ridden from the start, then shot)  SIZE=1280x648@2
     TOL=0.3  QUALITY=medium  SHOTS=1  SETTLE=8 (s per held spot; photoreal tiles stream)  SAMPLES=6
"""
import json
import os
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from scenic_home import ride_scenic_route  # noqa: E402

out = pathlib.Path(sys.argv[1])
base = sys.argv[2]
ROUTES = (sys.argv[3] if len(sys.argv) > 3 else
          "scenic-perugia-tiber-park,scenic-assisi-valley,scenic-trasimeno-shore,scenic-lugano-melide,"
          "scenic-chengdu-luxe-lakes,scenic-cuyahoga-towpath,scenic-santa-monica-strand").split(",")
SPOTS = [float(s) for s in os.environ.get("SPOTS", "1000,3000,5000").split(",") if s]
START_M = float(os.environ.get("START_M", "100"))
SIZE = os.environ.get("SIZE", "1280x648@2")
TOL = float(os.environ.get("TOL", "0.3"))
POP_M = 0.5
QUALITY = os.environ.get("QUALITY", "medium")
SHOTS = os.environ.get("SHOTS", "1") == "1"
SETTLE = float(os.environ.get("SETTLE", "8"))
SAMPLES = int(os.environ.get("SAMPLES", "6"))
out.mkdir(parents=True, exist_ok=True)

INIT = """
localStorage.setItem('velo.debug.three', '1');
localStorage.setItem('velo.debug.cesium', '1');
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
let cur = {}; try { cur = JSON.parse(localStorage.getItem('globeride.settings.v1') || '{}'); } catch {}
cur.state = Object.assign(cur.state || {}, { graphicsQuality: '%s', graphicsQualityAuto: false }); cur.version = 1;
localStorage.setItem('globeride.settings.v1', JSON.stringify(cur));
""" % QUALITY

# One sample of the drawn surfaces under the rider (and the camera). Returns null until a scene is up.
SAMPLE = r"""(tol) => {
  const d = window.__veloRideDebug && window.__veloRideDebug();
  if (!d) return null;
  if (d.renderer === 'world') {
    const t = window.__veloThree; if (!t || !d.riderXZ) return null;
    const { scene, camera } = t;
    const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const kind = (o) => { for (let p = o; p && p !== scene; p = p.parent) {
      if (p.name === 'terrain') return 'terrain'; if (p.name === 'roads') return 'road';
      if (p.name === 'route-line') return 'route'; if (p.name === 'rider') return 'rider'; }
      return 'other'; };
    const ray = (X, Z) => { const hits = [];
      scene.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh || !o.geometry || !visible(o)) return;
        const k = kind(o); if (k === 'rider' || k === 'other') return;
        const g = o.geometry, pos = g.attributes.position; if (!pos) return;
        o.updateWorldMatrix(true, false); const e = o.matrixWorld.elements;
        if (!g.boundingSphere) g.computeBoundingSphere(); const bs = g.boundingSphere;
        const cx = e[0]*bs.center.x + e[4]*bs.center.y + e[8]*bs.center.z + e[12];
        const cz = e[2]*bs.center.x + e[6]*bs.center.y + e[10]*bs.center.z + e[14];
        if (Math.hypot(cx - X, cz - Z) > bs.radius * Math.hypot(e[0], e[1], e[2]) + 1) return;
        const idx = g.index ? g.index.array : null, n = idx ? idx.length : pos.count, a = pos.array, st = pos.itemSize;
        const W = (i) => { const x = a[i*st], y = a[i*st+1], z = a[i*st+2];
          return [e[0]*x + e[4]*y + e[8]*z + e[12], e[1]*x + e[5]*y + e[9]*z + e[13], e[2]*x + e[6]*y + e[10]*z + e[14]]; };
        const ys = [];
        for (let q = 0; q + 2 < n; q += 3) {
          const p0 = W(idx ? idx[q] : q), p1 = W(idx ? idx[q+1] : q+1), p2 = W(idx ? idx[q+2] : q+2);
          const den = (p1[2]-p2[2])*(p0[0]-p2[0]) + (p2[0]-p1[0])*(p0[2]-p2[2]);
          if (Math.abs(den) < 1e-9) continue;   // vertical skirt walls
          const l0 = ((p1[2]-p2[2])*(X-p2[0]) + (p2[0]-p1[0])*(Z-p2[2])) / den;
          const l1 = ((p2[2]-p0[2])*(X-p2[0]) + (p0[0]-p2[0])*(Z-p2[2])) / den;
          const l2 = 1 - l0 - l1;
          if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
          const y = l0*p0[1] + l1*p1[1] + l2*p2[1];
          if (!ys.some((v) => Math.abs(v - y) < 0.02)) ys.push(y);   // shared edges
        }
        for (const y of ys) hits.push({ kind: k, name: o.name, y });
      });
      return hits.sort((p, q) => q.y - p.y); };
    const rider = d.groundEle;
    const atRider = ray(d.riderXZ[0], d.riderXZ[1]);
    const atCam = ray(camera.position.x, camera.position.z);
    const top = atRider.length ? atRider[0].y : null;
    const above = atRider.filter((h) => h.y > rider + tol).length;
    // Road surfaces in the column: ribbon and route-line hits grouped into levels (a junction's two
    // overlapping ribbons, or the line on its road, are one level; a copy metres below is a second).
    const roadYs = atRider.filter((h) => h.kind === 'road' || h.kind === 'route').map((h) => h.y);
    let roadLevels = 0;
    for (let i = 0; i < roadYs.length; i++) if (i === 0 || roadYs[i - 1] - roadYs[i] > tol) roadLevels++;
    const camTop = atCam.length ? atCam[0].y : null;
    const ok = top !== null && Math.abs(rider - top) <= tol && above === 0 && roadLevels <= 1 &&
      (camTop === null || camera.position.y > camTop);
    return { renderer: 'world', dist: d.distance, rider, top, riderVsTop: top === null ? null : rider - top, above,
      roadLevels, camVsTop: camTop === null ? null : camera.position.y - camTop,
      hits: atRider.map((h) => [h.kind, h.name, Math.round(h.y * 1000) / 1000]), nearChunks: d.nearChunks, ok };
  }
  const c = window.__veloCesium; if (!c || !d.riderLonLat) return null;
  const { viewer, Cesium } = c; const scene = viewer.scene, globe = scene.globe;
  const ts = c.photoreal && c.photoreal();
  const meshShown = !!(ts && !ts.isDestroyed() && ts.show);
  const globeOpaque = globe.show !== false && !(globe.translucency && globe.translucency.enabled);
  const near = (h) => (h !== undefined && Number.isFinite(h) && Math.abs(h - d.groundEle) < 60 ? h : null);
  const surfaces = (carto) => { const s = [];
    if (globeOpaque) { const h = near(globe.getHeight(carto)); if (h !== null) s.push(['globe', h]); }
    if (meshShown) { const h = near(ts.getHeight(carto, scene)); if (h !== null) s.push(['mesh', h]); }
    return s; };
  const atRider = surfaces(Cesium.Cartographic.fromDegrees(d.riderLonLat[0], d.riderLonLat[1]));
  const cam = viewer.camera.positionCartographic;
  const atCam = surfaces(cam);
  // The mesh reads the top of whatever is there: >= OVERHANG over the wheels is a tree, lamp or bridge
  // the rider passes under, not ground. The globe is bare terrain: anything of it over the wheels is
  // the owner's bug (riding under the terrain).
  const OVERHANG = 2.5;
  const ground = (list, h) => list.filter((s) => !(s[0] === 'mesh' && s[1] - h >= OVERHANG));
  const g = ground(atRider, d.groundEle);
  const overhang = atRider.length - g.length;
  const top = g.length ? Math.max(...g.map((s) => s[1])) : null;
  const camGround = ground(atCam, d.groundEle);
  const camTop = camGround.length ? Math.max(...camGround.map((s) => s[1])) : null;
  const above = g.filter((s) => s[1] > d.groundEle + tol).length;
  // On a structure: > 6 m over the opaque bare terrain (tree canopy, viaduct deck). The mesh height under
  // the wheels is then unknowable from one top-of-mesh ray; reported on its own, not as ground error.
  const bare = atRider.find((s) => s[0] === 'globe');
  const onStructure = !!bare && d.groundEle - bare[1] > 6;
  // Under an overhang (deck, canopy) within 2 m over the bare terrain: the road under it is invisible to
  // a top-of-mesh ray, so |rider - ground| can't be checked; counted apart.
  const underOverhang = overhang > 0 && !!bare && d.groundEle - bare[1] >= -tol && d.groundEle - bare[1] <= 2;
  const ok = top !== null && Math.abs(d.groundEle - top) <= tol && above === 0 && (camTop === null || cam.height > camTop);
  return { renderer: 'photoreal', dist: d.dist, rider: d.groundEle, top, riderVsTop: top === null ? null : d.groundEle - top,
    above, overhang, onStructure, underOverhang, camVsTop: camTop === null ? null : cam.height - camTop, surfaces: atRider, camSurfaces: atCam,
    meshShown, meshLoaded: meshShown ? ts.tilesLoaded : null, globeLoaded: globe.tilesLoaded, ok };
}"""

PLACE = """(m) => { if (window.__veloWorldLight) window.__veloWorldLight.place(m);
  else if (window.__veloCesium && window.__veloCesium.place) window.__veloCesium.place(m); }"""

dims, _, dpr = SIZE.partition("@")
W, H = (int(v) for v in dims.split("x"))
report = {"base": base, "size": SIZE, "quality": QUALITY, "tol": TOL, "routes": []}
failed = 0


def under(s):
    """Rider below a drawn ground surface, or camera at/under one: the owner's bug."""
    return (s["riderVsTop"] is not None and s["riderVsTop"] < -TOL) or s["above"] > 0 or \
        (s["camVsTop"] is not None and s["camVsTop"] <= 0)


def fmt(s):
    if not s:
        return "no sample"
    f = lambda v: "-" if v is None else f"{v:+.2f}"  # noqa: E731
    extra = f" roadLevels={s['roadLevels']}" if s["renderer"] == "world" else \
        " " + " ".join(f"{k}={v:.2f}" for k, v in s["surfaces"])
    oh = f" overhang={s['overhang']}" if s.get("overhang") else ""
    return f"rider-top={f(s['riderVsTop'])} above={s['above']} cam-top={f(s['camVsTop'])}{extra}{oh} {'ok' if s['ok'] else 'FAIL'}"


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=os.environ.get("PW_CHROMIUM", "/usr/sbin/chromium"),
                          args=["--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu", "--ignore-gpu-blocklist"])
    for route in ROUTES:
        ctx = b.new_context(viewport={"width": W, "height": H}, device_scale_factor=float(dpr or 1), service_workers="block")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(INIT)
        page.goto(base + "/app")
        ride_scenic_route(page, route, timeout=90000)
        page.wait_for_url("**/ride**", timeout=60000)
        page.wait_for_function("() => window.__veloRideDebug && window.__veloRideDebug()", timeout=180000)
        short = route.replace("scenic-", "")
        r = {"route": route, "start": [], "spots": [], "errors": errs}
        # The start, ridden: every sample from the first frame until START_M.
        t0 = time.time()
        while time.time() - t0 < 240:
            s = page.evaluate(SAMPLE, TOL)
            if s:
                s["t"] = round(time.time() - t0, 2)
                r["start"].append(s)
                if (s["dist"] or 0) >= START_M:
                    break
            time.sleep(0.3)
        moving = [s for s in r["start"] if (s["dist"] or 0) > 0]
        # A pop: the rider's height jumps more between samples than any road climbs.
        for a, c in zip(moving, moving[1:]):
            dd = abs((c["dist"] or 0) - (a["dist"] or 0))
            if abs(c["rider"] - a["rider"]) > POP_M + 0.3 * dd:
                c["ok"] = False
                c["pop"] = round(c["rider"] - a["rider"], 2)
        # Hard: under a drawn surface (rider or camera), the owner's bug. Soft: floating or popping
        # while ridden (the avatar easing across a step of the photoreal mesh), reported, not fatal.
        for s in moving:
            s["under"] = under(s)
        bad = [s for s in moving if s["under"]]
        soft = [s for s in moving if not s["ok"] and not s["under"]]
        r["startSoft"] = len(soft)
        r["startPops"] = sum(1 for s in moving if "pop" in s)
        r["startFailures"] = len(bad)
        r["startWorst"] = max((abs(s["riderVsTop"]) for s in moving if s["riderVsTop"] is not None), default=None)
        first_move = next((s["t"] for s in r["start"] if (s["dist"] or 0) > 0), None)
        print(f"{route} [{r['start'][-1]['renderer'] if r['start'] else '?'}] start (moved at t={first_move}s): "
              f"{len(moving)} ridden samples, {len(bad)} under a drawn surface, {len(soft)} off by >{TOL} m "
              f"({r['startPops']} pops), worst |rider-top| {r['startWorst'] and round(r['startWorst'], 2)}", flush=True)
        if SHOTS:
            page.mouse.move(5, 5)
            page.screenshot(path=str(out / f"{short}-{int(START_M)}-{W}x{H}.png"))
        spot = {"m": START_M, "ridden": True, "samples": r["start"][-3:]}
        r["spots"].append(spot)
        for m in SPOTS:
            # Arrive like a ride: settle 60 m short, then roll in at 2 m steps (the photoreal overhang
            # filter follows the road from where it was; a bare teleport has no road to follow).
            page.evaluate(PLACE, max(0.0, m - 60))
            time.sleep(SETTLE)
            x = max(0.0, m - 60)
            roll = []
            while x < m:
                x = min(m, x + 2)
                page.evaluate(PLACE, x)
                time.sleep(0.1)
                if int(x) % 6 == 0:
                    rs = page.evaluate(SAMPLE, TOL)
                    if rs:
                        roll.append({k: rs.get(k) for k in ("dist", "rider", "top", "surfaces", "ok")})
            time.sleep(2)
            samples = []
            for _ in range(SAMPLES):
                s = page.evaluate(SAMPLE, TOL)
                if s:
                    samples.append(s)
                time.sleep(0.5)
            if SHOTS:
                page.mouse.move(5, 5)
                page.screenshot(path=str(out / f"{short}-{int(m)}-{W}x{H}.png"))
            # Held: +-TOL, except samples on a structure or under an overhang that are not under anything
            # drawn (the road height there is not visible to the probe; counted apart).
            apart = lambda s: (s.get("onStructure") or s.get("underOverhang")) and not under(s)  # noqa: E731
            n_struct = sum(1 for s in samples if apart(s))
            n_bad = sum(1 for s in samples if not s["ok"] and not apart(s))
            r["spots"].append({"m": m, "samples": samples, "failures": n_bad, "onStructure": n_struct, "roll": roll})
            st = f", {n_struct} on a structure / under an overhang" if n_struct else ""
            print(f"  {int(m):>5} m: {fmt(samples[-1] if samples else None)} ({n_bad}/{len(samples)} failing{st})", flush=True)
        route_failed = r["startFailures"] > 0 or any(sp.get("failures") for sp in r["spots"]) or \
            any(not sp["samples"] for sp in r["spots"])
        r["ok"] = not route_failed
        failed += route_failed
        report["routes"].append(r)
        ctx.close()
    b.close()

report["failedRoutes"] = failed
(out / f"surface-probe-{W}x{H}.json").write_text(json.dumps(report, indent=1) + "\n")
print(f"{len(ROUTES) - failed}/{len(ROUTES)} routes pass ({out / f'surface-probe-{W}x{H}.json'})", flush=True)
sys.exit(1 if failed else 0)
