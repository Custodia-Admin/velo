# Drive the render Chrome on cat-bed (CDP via ssh tunnel) into a Velo demo ride and inject the render agent.
# Usage: server_page.py [cdp_port] [room] [route_index]
import sys, time, json, pathlib
from playwright.sync_api import sync_playwright
port = sys.argv[1] if len(sys.argv) > 1 else '9223'
room = sys.argv[2] if len(sys.argv) > 2 else 'a'
idx = int(sys.argv[3]) if len(sys.argv) > 3 else 0
agent = pathlib.Path(__file__).with_name('www').joinpath('render-agent.js').read_text()
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
    ctx = b.contexts[0]
    page = ctx.pages[0]
    page.goto('http://127.0.0.1:4180/app')
    page.wait_for_selector('[data-scenic-route]', timeout=30000)
    time.sleep(2)
    # dismiss any welcome/onboarding dialog
    for sel in ['button:has-text("Skip")', 'button:has-text("Get started")', 'button:has-text("Close")', '[aria-label="Close"]']:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                el.click(); time.sleep(0.5)
        except Exception:
            pass
    cards = page.query_selector_all('[data-scenic-route]')
    print('route cards', len(cards), 'picking', cards[idx].get_attribute('data-scenic-route'))
    page.evaluate('(i) => document.querySelectorAll("[data-scenic-route]")[i].click()', idx)
    page.wait_for_url('**/ride**', timeout=30000)
    time.sleep(12)
    page.evaluate(f'window.__veloRenderOpts = "relay=ws://127.0.0.1:8095/ws&room={room}"')
    print('agent', page.evaluate(agent))
    time.sleep(5)
    print(json.dumps(page.evaluate('window.__veloRender.summary()')))
    dbg = page.evaluate('typeof window.__veloRideDebug === "function" ? window.__veloRideDebug() : null')
    print('rideDebug', json.dumps(dbg)[:600])
    print('banner', page.evaluate('[...document.querySelectorAll("*")].filter(e=>/token|unavailable/i.test(e.textContent||"") && e.children.length===0).map(e=>e.textContent.trim()).slice(0,3)'))
