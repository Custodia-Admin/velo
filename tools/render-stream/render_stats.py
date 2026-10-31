# Poll render-page stats via CDP. Usage: render_stats.py [cdp_port] [seconds]
import sys, time, json
from playwright.sync_api import sync_playwright
port = sys.argv[1] if len(sys.argv) > 1 else '9223'
secs = int(sys.argv[2]) if len(sys.argv) > 2 else 10
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
    page = b.contexts[0].pages[0]
    for _ in range(max(1, secs // 5)):
        time.sleep(5)
        print(json.dumps({k: (round(v, 1) if isinstance(v, float) else v) for k, v in page.evaluate('window.__veloRender.summary()').items()}))
    if len(sys.argv) > 3:
        print(page.evaluate(sys.argv[3]))
