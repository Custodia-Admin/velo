"""Token-mode terrain + Home shots: home-<vp>.png / home-full-<vp>.png (route
sections printed), ride-terrain-1440.png and a scene-only copy, banner count,
pixel variety of the lower half, and window.__veloRideDebug() heights.

Usage: uv run --with playwright --with pillow python scripts/terrain-shots.py <out> [base]
"""
import re, sys, json, pathlib
from playwright.sync_api import sync_playwright
from PIL import Image
out=pathlib.Path(sys.argv[1]); base=sys.argv[2] if len(sys.argv)>2 else "http://localhost:4173"
GPU=["--use-angle=vulkan","--enable-features=Vulkan","--enable-gpu","--ignore-gpu-blocklist"]
def variety(path):
    im=Image.open(path).convert('RGB'); w,h=im.size
    crop=im.crop((0,int(h*0.45),w,h)).resize((160,80))
    px=list(crop.getdata()); q=set((r//16,g//16,b//16) for r,g,b in px)
    avg=tuple(sum(c[i] for c in px)//len(px) for i in range(3))
    return len(q), avg
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/sbin/chromium',args=GPU)
    for vp,(w,h) in {"1440":(1440,900),"390":(390,844)}.items():
        ctx=b.new_context(viewport={"width":w,"height":h},color_scheme="dark")
        ctx.add_init_script("localStorage.setItem('globeride.onboarding.v2', JSON.stringify({state:{hasSeenOnboarding:true},version:2}));")
        pg=ctx.new_page()
        msgs=[]; pg.on("console", lambda m: msgs.append(m.text) if m.type in ("error","warning") else None)
        pg.goto(f"{base}/app",wait_until="domcontentloaded",timeout=60000)
        pg.wait_for_timeout(5000)
        pg.screenshot(path=str(out/f"home-{vp}.png"))
        pg.screenshot(path=str(out/f"home-full-{vp}.png"),full_page=True)
        sec=pg.evaluate("""() => [...document.querySelectorAll('section[aria-label]')].map(s=>s.getAttribute('aria-label')+': '+[...s.querySelectorAll('h3,h4')].map(h=>h.textContent.trim()).join(' / ')).slice(0,8)""")
        print(vp,"home sections:",json.dumps(sec)[:1500])
        print(vp,"scroll",pg.evaluate("[document.documentElement.scrollWidth,document.documentElement.clientWidth]"))
        if vp=="1440":
            pg.get_by_role("button", name=re.compile(r"^Ride ")).first.click()
            pg.wait_for_url("**/ride**",wait_until="commit",timeout=20000)
            pg.wait_for_timeout(20000)
            shot=out/f"ride-terrain-{vp}.png"; pg.screenshot(path=str(shot))
            banner=pg.locator("text=Photoreal terrain").count(); print("ride debug", pg.evaluate("() => window.__veloRideDebug && window.__veloRideDebug()"))
            pg.add_style_tag(content="body *{visibility:hidden !important} canvas{visibility:visible !important}"); pg.screenshot(path=str(out/f"ride-terrain-scene-{vp}.png")); print("scene variety", variety(out/f"ride-terrain-scene-{vp}.png"))
            st=pg.evaluate("""() => { const v=window.__DBG_VIEWER; const C=window.Cesium; let tp=null;
              try { const vw=[...document.querySelectorAll('canvas')].length; tp=vw } catch(e){}
              const body=document.body.innerText; const m=body.match(/([0-9.,]+)\\s*\\n?\\s*M ELEV/i); return {canvases:tp, elev: m?m[1]:null} }""")
            print(vp,"banner count:",banner,"state:",st,"variety:",variety(shot))
            print("errors:", [m for m in msgs if 'ion' in m.lower() or 'terrain' in m.lower() or '401' in m][:8])
        ctx.close()
    b.close()
