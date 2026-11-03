# Laptop client: open the spike client page (or the Selkies page + injected measure.js), measure for N s.
# Usage: client_measure.py <label> <seconds> [mode=client|selkies] [room] [headed=0] [base_url]
import subprocess, time, json, sys, pathlib, os
from playwright.sync_api import sync_playwright
label = sys.argv[1]; secs = int(sys.argv[2]); mode = sys.argv[3] if len(sys.argv) > 3 else 'client'
room = sys.argv[4] if len(sys.argv) > 4 else 'a'
headed = len(sys.argv) > 5 and sys.argv[5] == '1'
base = sys.argv[6] if len(sys.argv) > 6 else 'https://cat-bed.tail6f8715.ts.net:8443'
pw = subprocess.check_output(['ssh', 'cat-bed', 'cut -d= -f2 ~/velo-stream/auth.conf']).decode().strip()
url = f'{base}/velo-relay/client.html?room={room}' if mode == 'client' else f'{base}/'
here = pathlib.Path(__file__).parent
measure = (here / 'www' / 'measure.js').read_text()
hook = (here / 'www' / 'pc-hook.js').read_text()
# --use-angle=gl + AcceleratedVideoDecodeLinuxGL is what gives Chrome on Linux (Intel Arc, VA-API) hardware H.264 decode;
# with ANGLE on Vulkan the decode-profile list is empty and WebRTC falls back to software.
args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-angle=gl', '--enable-features=AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL,VaapiIgnoreDriverChecks', '--enable-gpu', '--ignore-gpu-blocklist']
if os.environ.get('PLAIN'): args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
if os.environ.get('CHROME_ARGS'): args += os.environ['CHROME_ARGS'].split()
STATS_JS = '(async () => { const f = document.getElementById("sk"); const w = f ? f.contentWindow : window; return w.__rtcStats ? await w.__rtcStats() : null; })()'
with sync_playwright() as p:
    cdp = os.environ.get('CDP_CLIENT')
    b = p.chromium.connect_over_cdp(f'http://127.0.0.1:{cdp}') if cdp else p.chromium.launch(channel='chrome', headless=not headed, args=args)
    ctx = b.new_context(http_credentials={'username': 'ubuntu', 'password': pw}, viewport={'width': 1920, 'height': 1080})
    ctx.add_init_script(hook)
    try:
        ctx.grant_permissions(['camera', 'microphone'], origin=base)
    except Exception as e:
        print('grant failed', e)
    page = ctx.new_page()
    page.goto(url)
    if mode == 'selkies':
        page.wait_for_function('document.querySelector("video#stream") && document.querySelector("video#stream").srcObject', timeout=30000)
        page.evaluate(f'window.__veloRoom="{room}"; window.__veloRelayBase="/velo-relay"')
        page.evaluate(measure)
    page.wait_for_function('window.__velo && window.__velo.frames > 30', timeout=40000)
    print('unlock', page.evaluate('(async () => { const f = document.getElementById("sk"); const w = f ? f.contentWindow : window; return w.__unlockStats ? await w.__unlockStats() : "none"; })()'))
    time.sleep(5)
    page.evaluate('window.__velo.reset()')
    out = []; prev = page.evaluate(STATS_JS)
    for i in range(secs // 10):
        time.sleep(10)
        s = page.evaluate('window.__velo.summary()'); s['t'] = (i + 1) * 10
        r = page.evaluate(STATS_JS)
        if r and prev and r.get('bytes') and prev.get('bytes'):
            r['kbps'] = round(8 * (r['bytes'] - prev['bytes']) / (r['t'] - prev['t']))
        prev = r; s['rtc'] = r
        print(json.dumps(s), flush=True); out.append(s)
    page.screenshot(path=f'client-{label}.png')
    final = page.evaluate('window.__velo.summary()'); final['rtc'] = prev
    raw = page.evaluate('({lat: window.__velo.lat, up: window.__velo.up, recv: window.__velo.latRecv})')
    json.dump({'label': label, 'mode': mode, 'headed': headed, 'final': final, 'series': out, 'raw': raw}, open(f'result-{label}.json', 'w'), indent=1)
    print('FINAL', json.dumps(final))
    ctx.close()
    if not cdp: b.close()
