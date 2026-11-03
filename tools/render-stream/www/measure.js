// Velo render-streaming spike — client side. Works in two ways:
//  * loaded by www/client.html (same origin as the Selkies client, which runs in a hidden iframe
//    and does the WebRTC signalling; we take its MediaStream into our own <video id="world">);
//  * injected into the Selkies page itself (then it measures <video id="stream">).
// It streams ride state to the relay at HZ (default 20), and measures input-echo latency: the
// render page paints the low byte of the last state seq as a block marker; we detect it in
// decoded frames with requestVideoFrameCallback and subtract the send time.
(() => {
  if (window.__velo) return 'already';
  const qs = new URLSearchParams(location.search);
  const ROOM = qs.get('room') || window.__veloRoom || 'a';
  const HZ = +(qs.get('hz') || window.__veloHz || 20);
  const relayBase = window.__veloRelayBase || (location.pathname.includes('/velo-relay/') ? '/velo-relay' : '/velo-relay');
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + relayBase + '/ws?role=client&room=' + ROOM;
  const now = () => performance.timeOrigin + performance.now();
  const R = window.__velo = {
    room: ROOM, hz: HZ, seq: 0, byLow: new Map(), bySeq: new Map(),
    lat: [], latRecv: [], up: [], offset: null, rttMin: Infinity, rtts: [],
    frames: 0, present: [], proc: [], dropped: 0, lastPresented: null, lastV: -1,
    renderUp: false, ws: 'connecting', ticks: 0, videoW: 0, videoH: 0, started: now(),
  };

  // ---- video source
  const findVideo = () => {
    const own = document.getElementById('world');
    if (own) {
      const fr = document.getElementById('sk');
      const inner = fr && fr.contentDocument && fr.contentDocument.querySelector('video#stream');
      if (inner && inner.srcObject && own.srcObject !== inner.srcObject) { own.srcObject = inner.srcObject; own.play().catch(() => {}); }
      return own.srcObject ? own : null;
    }
    const v = document.querySelector('video#stream');
    return v && v.srcObject ? v : null;
  };

  const cv = document.createElement('canvas'); cv.width = 576; cv.height = 32;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  let video = null;
  const onFrame = (_t, md) => {
    R.frames++;
    R.videoW = md.width; R.videoH = md.height;
    if (R.lastPresented != null && md.presentedFrames - R.lastPresented > 1) R.dropped += md.presentedFrames - R.lastPresented - 1;
    R.lastPresented = md.presentedFrames;
    const disp = performance.timeOrigin + md.expectedDisplayTime;
    R.present.push(disp); if (R.present.length > 3600) R.present.shift();
    if (md.processingDuration != null) { R.proc.push(md.processingDuration * 1000); if (R.proc.length > 3600) R.proc.shift(); }
    try {
      cx.drawImage(video, 0, 0, 576, 32, 0, 0, 576, 32);
      const d = cx.getImageData(0, 0, 576, 32).data;
      const px = (i) => { let a = 0; for (let y = 12; y < 20; y += 2) for (let x = 12; x < 20; x += 2) { const o = (y * 576 + i * 32 + x) * 4; a += d[o] + d[o + 1] + d[o + 2]; } return a / 48; };
      const w = px(0), k = px(1);
      if (w - k > 100) {
        const mid = (w + k) / 2; let v = 0;
        let ok = true;
        for (let b = 0; b < 8; b++) { const bit = px(2 + b) > mid ? 1 : 0; if ((px(10 + b) > mid ? 1 : 0) === bit) ok = false; v = (v << 1) | bit; }
        if (!ok) R.bad = (R.bad || 0) + 1;
        if (ok && v !== R.lastV) {
          R.lastV = v;
          const s = R.byLow.get(v);
          if (s && !s.seen) {
            s.seen = true;
            R.lat.push(disp - s.at); if (R.lat.length > 2000) R.lat.shift();
            if (md.receiveTime) R.latRecv.push(performance.timeOrigin + md.receiveTime - s.at);
          }
        }
      }
    } catch (e) { R.err = String(e); }
    video.requestVideoFrameCallback(onFrame);
  };
  const waitVideo = setInterval(() => {
    const v = findVideo();
    if (v && !video) { video = v; clearInterval(waitVideo); video.requestVideoFrameCallback(onFrame); }
  }, 250);

  // ---- state uplink + clock offset
  let ws, sendTimer, pingTimer;
  const connect = () => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      R.ws = 'open';
      sendTimer = setInterval(() => {
        const seq = ++R.seq, at = now();
        R.byLow.set(seq & 255, { seq, at, seen: false });
        R.bySeq.set(seq, at); if (R.bySeq.size > 400) R.bySeq.delete(R.bySeq.keys().next().value);
        const tt = (at - R.started) / 1000;
        ws.send(JSON.stringify({ t: 'state', seq, sentAt: at, distM: tt * 9, speedKmh: 32.4, grade: 3.1, heading: (tt * 3) % 360, gear: 7, cam: 'chase', lat: 43.11, lon: 12.39 }));
      }, 1000 / HZ);
      pingTimer = setInterval(() => {
        ws.send(JSON.stringify({ t: 'ping', c0: now() }));
        // every 5 s: a report the relay appends to reports.jsonl, so device runs are recorded without a debugger
        if (++R.ticks % 5 === 0 && R.frames > 60) ws.send(JSON.stringify({ t: 'report', ua: navigator.userAgent, screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, s: R.summary() }));
      }, 1000);
    };
    ws.onclose = () => { R.ws = 'closed'; clearInterval(sendTimer); clearInterval(pingTimer); setTimeout(connect, 1000); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data), t1 = now();
      if (m.t === 'pong') {
        const rtt = t1 - m.c0; R.rtts.push(rtt); if (R.rtts.length > 300) R.rtts.shift();
        if (rtt <= R.rttMin * 1.2 || R.offset == null) { R.offset = m.s - (m.c0 + t1) / 2; R.rttMin = Math.min(R.rttMin, rtt); }
      } else if (m.t === 'applied') {
        const at = R.bySeq.get(m.seq);
        if (at != null && R.offset != null) { R.up.push(m.s - R.offset - at); if (R.up.length > 2000) R.up.shift(); }
      } else if (m.t === 'presence' && m.role === 'render') {
        R.renderUp = m.up;
      }
    };
  };
  connect();

  // ---- summary
  const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1); };
  R.reset = () => { R.bad = 0; R.lat = []; R.latRecv = []; R.up = []; R.present = []; R.proc = []; R.dropped = 0; R.rtts = []; };
  R.summary = () => {
    const pr = R.present; const span = pr.length > 1 ? (pr[pr.length - 1] - pr[0]) / 1000 : 0;
    const iv = []; for (let i = 1; i < pr.length; i++) iv.push(pr[i] - pr[i - 1]);
    const slow = iv.filter((x) => x > 25).length;
    return {
      video: `${R.videoW}x${R.videoH}`, fps: span ? +((pr.length - 1) / span).toFixed(1) : null,
      frameIntP50: pct(iv, 0.5), frameIntP95: pct(iv, 0.95), frameIntP99: pct(iv, 0.99), slowFramePct: iv.length ? +(100 * slow / iv.length).toFixed(2) : null,
      dropped: R.dropped, decodeP50: pct(R.proc, 0.5), decodeP95: pct(R.proc, 0.95),
      latN: R.lat.length, latP50: pct(R.lat, 0.5), latP95: pct(R.lat, 0.95), latMin: pct(R.lat, 0), latMax: pct(R.lat, 1),
      toRecvP50: pct(R.latRecv, 0.5), upP50: pct(R.up, 0.5), upP95: pct(R.up, 0.95), rttP50: pct(R.rtts, 0.5), rttP95: pct(R.rtts, 0.95),
      badMarker: R.bad || 0, renderUp: R.renderUp, ws: R.ws, err: R.err || null,
    };
  };
  const hud = document.getElementById('hud');
  if (hud) setInterval(() => {
    const s = R.summary();
    hud.textContent = s.renderUp ? `stream ${s.video} ${s.fps ?? '-'} fps  dropped ${s.dropped}\nstate→screen p50 ${s.latP50 ?? '-'} ms  p95 ${s.latP95 ?? '-'} ms (n=${s.latN})\nuplink p50 ${s.upP50 ?? '-'} ms  rtt ${s.rttP50 ?? '-'} ms  decode ${s.decodeP50 ?? '-'} ms`
      : 'renderer offline — a real client falls back to the local renderer';
  }, 500);
  return 'ok';
})();
