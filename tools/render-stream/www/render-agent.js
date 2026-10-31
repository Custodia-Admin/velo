// Velo render-streaming spike — injected into the render Chrome's Velo page on cat-bed.
// 1. hides the DOM HUD (world-only render; the client keeps the HUD), 2. connects to the
// relay as role=render, 3. paints the latest state seq as a 18-block marker (top-left,
// 32 px blocks: white, black, seq bits 7..0, then their complement as a check) for the client's input-echo latency
// measurement, 4. keeps rAF frame-time stats in window.__veloRender.
(() => {
  if (window.__veloRender) return 'already';
  const P = new URLSearchParams(window.__veloRenderOpts || '');
  const RELAY = P.get('relay') || 'ws://127.0.0.1:8095/ws';
  const ROOM = P.get('room') || 'a';
  const WORLD_ONLY = P.get('worldOnly') !== '0';
  const B = 32 / (window.devicePixelRatio || 1); // 32 device px per block, whatever the session DPI
  const st = { applied: 0, lastSeq: -1, lastState: null, ws: 'connecting', frames: [], fps: [] };
  window.__veloRender = st;

  if (WORLD_ONLY) {
    const css = document.createElement('style');
    css.textContent = 'body *{visibility:hidden !important} canvas{visibility:visible !important} #velo-marker,#velo-marker *{visibility:visible !important}';
    document.head.appendChild(css);
  }
  const m = document.createElement('div');
  m.id = 'velo-marker';
  m.style.cssText = `position:fixed;left:0;top:0;width:${B * 18}px;height:${B}px;display:flex;z-index:2147483647;pointer-events:none`;
  const cells = [];
  for (let i = 0; i < 18; i++) {
    const c = document.createElement('div');
    c.style.cssText = `width:${B}px;height:${B}px;background:${i === 0 ? '#fff' : '#000'}`;
    m.appendChild(c); cells.push(c);
  }
  document.body.appendChild(m);
  const paint = (seq) => {
    const v = seq & 255;
    for (let b = 0; b < 8; b++) { const bit = (v >> (7 - b)) & 1; cells[2 + b].style.background = bit ? '#fff' : '#000'; cells[10 + b].style.background = bit ? '#000' : '#fff'; }
  };
  paint(0);

  let ws;
  const connect = () => {
    ws = new WebSocket(`${RELAY}?role=render&room=${ROOM}`);
    ws.onopen = () => { st.ws = 'open'; };
    ws.onclose = () => { st.ws = 'closed'; setTimeout(connect, 1000); };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t !== 'state') return;
      st.lastSeq = msg.seq; st.lastState = msg; st.applied++;
      paint(msg.seq);
      // Spike: the state would drive the renderer here (camera/rider pose). Echo the apply time.
      ws.send(JSON.stringify({ t: 'applied', seq: msg.seq, s: Date.now() }));
    };
  };
  connect();

  // rAF stats: per-second fps + frame-time distribution of the last 10 s.
  let last = performance.now(), count = 0, secStart = last;
  const loop = (now) => {
    const dt = now - last; last = now; count++;
    st.frames.push(dt); if (st.frames.length > 600) st.frames.shift();
    if (now - secStart >= 1000) { st.fps.push(count * 1000 / (now - secStart)); if (st.fps.length > 120) st.fps.shift(); count = 0; secStart = now; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  st.summary = () => {
    const f = [...st.frames].sort((a, b) => a - b);
    const q = (p) => f[Math.min(f.length - 1, Math.floor(p * f.length))];
    const fps = st.fps.slice(-10);
    return { fpsAvg10s: fps.reduce((a, b) => a + b, 0) / (fps.length || 1), fpsMin10s: Math.min(...fps), frameP50: q(0.5), frameP95: q(0.95), frameP99: q(0.99), frameMax: f[f.length - 1], applied: st.applied, ws: st.ws };
  };
  return 'ok';
})();
