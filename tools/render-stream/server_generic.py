# Point the render Chrome (CDP) at any URL and inject the render agent. Usage: server_generic.py <cdp_port> <room> <url> [relay]
import sys, time, json, pathlib
from playwright.sync_api import sync_playwright
port, room, url = sys.argv[1], sys.argv[2], sys.argv[3]
relay = sys.argv[4] if len(sys.argv) > 4 else 'wss://cat-bed.tail6f8715.ts.net:8443/velo-relay/ws'
agent = pathlib.Path(__file__).with_name('www').joinpath('render-agent.js').read_text()
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
    page = b.contexts[0].pages[0]
    page.goto(url); time.sleep(8)
    page.evaluate(f'window.__veloRenderOpts = "relay={relay}&room={room}&worldOnly=0"')
    print('agent', page.evaluate(agent)); time.sleep(6)
    print(json.dumps(page.evaluate('window.__veloRender.summary()')))
