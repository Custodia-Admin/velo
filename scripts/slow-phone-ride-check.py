"""Slow-phone ride regression check (token build): 390 viewport, 4 cores
(photoreal off as on a phone), slow 3G from the moment Ride is tapped.
Polls window.__veloRideDebug() for 30 s and fails nothing silently: prints
ground/camera heights (camera must stay ~9 m over the ground, never at route
height over a void) plus scene-only screenshots (UI hidden).

Usage: uv run --with playwright --with pillow python scripts/slow-phone-ride-check.py <out> <tag> [base]
"""
import re, sys, json, pathlib
from playwright.sync_api import sync_playwright
from PIL import Image
out=pathlib.Path(sys.argv[1]); tag=sys.argv[2]; base=sys.argv[3] if len(sys.argv)>3 else "http://localhost:4173"
out.mkdir(parents=True, exist_ok=True)
GPU=["--use-angle=vulkan","--enable-features=Vulkan","--enable-gpu","--ignore-gpu-blocklist"]
def variety(path):
    im=Image.open(path).convert('RGB').resize((130,280)); px=list(im.get_flattened_data()) if hasattr(im,'get_flattened_data') else list(im.getdata())
    return len(set((r//16,g//16,b//16) for r,g,b in px))
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/sbin/chromium',args=GPU)
    ctx=b.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, device_scale_factor=1, service_workers="block")
    ctx.add_init_script("Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>4});localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));")
    pg=ctx.new_page()
    cdp=ctx.new_cdp_session(pg)
    pg.goto(f"{base}/app"); pg.wait_for_timeout(3000)
    cdp.send("Network.enable")
    cdp.send("Network.emulateNetworkConditions", {"offline":False,"latency":400,"downloadThroughput":50*1024,"uploadThroughput":20*1024})
    pg.evaluate("""() => [...document.querySelectorAll('button')].find(b=>/^Ride /.test(b.getAttribute('aria-label')||b.textContent.trim()))?.click()""")
    rows=[]
    for k in range(1,61):
        pg.wait_for_timeout(500)
        dbg=pg.evaluate("() => window.__veloRideDebug ? window.__veloRideDebug() : null")
        if dbg: rows.append((k/2,dbg))
        if k in (12,24,60):
            shot=out/f"throttled-{tag}-{k//2}s-390.png"; pg.screenshot(path=str(shot))
            print(tag, f"t={k/2}s", json.dumps(dbg), "variety", variety(shot), "banner", pg.locator("text=Photoreal terrain").count())
            pg.add_style_tag(content="body *{visibility:hidden !important} canvas{visibility:visible !important}")
            scene=out/f"throttled-{tag}-{k//2}s-390-scene.png"; pg.screenshot(path=str(scene))
            pg.evaluate("() => document.querySelectorAll('style').forEach(s => { if (s.textContent.includes('canvas{visibility:visible')) s.remove(); })")
            print(tag, "scene-only variety", variety(scene))
    if rows:
        gaps=[d["cameraHeight"]-d["groundEle"] for _,d in rows]
        print(tag,"samples",len(rows),"ground min/max",round(min(d["groundEle"] for _,d in rows),1),round(max(d["groundEle"] for _,d in rows),1),
              "camera-ground min/max",round(min(gaps),1),round(max(gaps),1),"camera min",round(min(d["cameraHeight"] for _,d in rows),1))
        print(tag,"trace",[(t,round(d["groundEle"]),round(d["cameraHeight"])) for t,d in rows[::4]])
    b.close()
