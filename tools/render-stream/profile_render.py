# CPU-profile the render page main thread for N seconds; print top self-time functions.
import sys, time, json, collections
from playwright.sync_api import sync_playwright
port = sys.argv[1] if len(sys.argv) > 1 else '9223'
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 5
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
    page = [pg for pg in b.contexts[0].pages if '4180' in pg.url][0]
    s = page.context.new_cdp_session(page)
    s.send('Profiler.enable'); s.send('Profiler.setSamplingInterval', {'interval': 500})
    s.send('Profiler.start'); time.sleep(secs)
    prof = s.send('Profiler.stop')['profile']
    nodes = {n['id']: n for n in prof['nodes']}
    dts = prof['timeDeltas']; samples = prof['samples']
    self_t = collections.Counter()
    for sid, dt in zip(samples, dts):
        n = nodes[sid]; cf = n['callFrame']
        key = f"{cf['functionName'] or '(anon)'} {cf['url'].split('/')[-1]}:{cf['lineNumber']}"
        self_t[key] += dt
    total = sum(dts)
    print(f'total {total/1000:.0f} ms over {secs}s')
    for k, v in self_t.most_common(25):
        print(f'{v/1000:8.0f} ms {100*v/total:5.1f}%  {k}')
    # inclusive by top-level url bucket
    json.dump(prof, open('render-profile.cpuprofile', 'w'))
