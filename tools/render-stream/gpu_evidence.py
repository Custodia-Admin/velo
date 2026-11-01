# Read chrome://gpu from the render Chrome via CDP (tunnel 9223 first) and save the evidence.
import json, sys, time
from playwright.sync_api import sync_playwright
out = sys.argv[1] if len(sys.argv) > 1 else 'gpu.json'
port = sys.argv[2] if len(sys.argv) > 2 else '9223'
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
    ctx = b.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    if not page.url.startswith('chrome://gpu'):
        page.goto('chrome://gpu')
    time.sleep(3)
    txt = page.evaluate("""() => {
      const walk = (n) => { let s=''; if (n.shadowRoot) s += walk(n.shadowRoot); for (const c of n.childNodes) { if (c.nodeType===3) s += c.textContent; else if (c.nodeType===1) { s += walk(c); if (/^(DIV|TR|LI|H\\d|P|TABLE)$/.test(c.tagName)) s += '\\n'; else if (c.tagName==='TD') s+='\\t'; } } return s; };
      return walk(document.body);
    }""")
    open(out.replace('.json', '.txt'), 'w').write(txt)
    keys = ['Canvas', 'WebGL', 'WebGL2', 'WebGPU', 'GL_RENDERER', 'GL_VENDOR', 'GL implementation parts', 'Display type', 'Vulkan', 'Rasterization', 'Video Decode', 'Video Encode', 'Skia Backend', 'GPU0', 'Compositing']
    lines = [l for l in txt.splitlines() if any(l.strip().startswith(k) for k in keys)]
    print('\n'.join(lines[:40]))
    gl = page.evaluate("""() => { const c=document.createElement('canvas'); const g=c.getContext('webgl2'); if(!g) return null; const e=g.getExtension('WEBGL_debug_renderer_info'); return {v:g.getParameter(e.UNMASKED_VENDOR_WEBGL), r:g.getParameter(e.UNMASKED_RENDERER_WEBGL)}; }""")
    print('WEBGL2 UNMASKED', gl)
    json.dump({'webgl': gl, 'lines': lines}, open(out, 'w'), indent=1)
