import sys, time, json, pathlib
from playwright.sync_api import sync_playwright
port = sys.argv[1]; js = pathlib.Path(sys.argv[2]).read_text()
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
    page = [pg for pg in b.contexts[0].pages if '4180' in pg.url][0]
    print(page.evaluate(js))
