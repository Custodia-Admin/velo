// Velo v2 mockup runtime: theme + TV layout switch, lucide icons, route SVGs.
// ?theme=night -> deep night theme (class="dark"); default paper day.
// data-layout="tv" when the viewport is >= 1600 px wide (stand-in for the P3.3
// useLayoutMode hook) or ?layout=tv.
(function () {
  const q = new URLSearchParams(location.search);
  const html = document.documentElement;
  if (q.get('theme') === 'night') html.classList.add('dark');
  const tv = q.get('layout') === 'tv' || (q.get('layout') !== 'default' && window.innerWidth >= 1600);
  if (tv) html.setAttribute('data-layout', 'tv');
  document.addEventListener('DOMContentLoaded', () => {
    const D = window.V2_DATA;
    const NS = 'http://www.w3.org/2000/svg';
    // theme-dependent sources: <img data-night-src="...">
    if (html.classList.contains('dark')) {
      document.querySelectorAll('img[data-night-src]').forEach((img) => { img.src = img.dataset.nightSrc; });
    }
    document.querySelectorAll('i[data-icon]').forEach((el) => {
      const nodes = D.icons[el.dataset.icon];
      if (!nodes) throw new Error('missing icon ' + el.dataset.icon);
      const svg = document.createElementNS(NS, 'svg');
      for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
      svg.setAttribute('class', 'icon ' + (el.className || ''));
      for (const [tag, attrs] of nodes) {
        const n = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        svg.appendChild(n);
      }
      el.replaceWith(svg);
    });
    // elevation profile: <svg class="profile" data-profile="route-id" data-at="0.38" data-h="40">
    document.querySelectorAll('svg[data-profile]').forEach((svg) => {
      const r = D.routes[svg.dataset.profile];
      const W = 1000, H = Number(svg.dataset.h || 60);
      const ds = r.profile.map((p) => p[0]), hs = r.profile.map((p) => p[1]);
      const d0 = ds[ds.length - 1];
      // keep flat routes looking flat: at least 60 m of vertical range
      const lo = Math.min(...hs), hi = Math.max(...hs, lo + 60);
      const X = (d) => (d / d0) * W, Y = (h) => H - 2 - ((h - lo) / (hi - lo)) * (H - 6);
      const pts = r.profile.map(([d, h]) => `${X(d).toFixed(1)},${Y(h).toFixed(1)}`);
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      const at = svg.dataset.at ? Number(svg.dataset.at) : null;
      let inner = `<path class="area" d="M0,${H} L${pts.join(' L')} L${W},${H} Z"/>`;
      if (at != null) {
        const cut = r.profile.filter(([d]) => d <= at * d0).map(([d, h]) => `${X(d).toFixed(1)},${Y(h).toFixed(1)}`);
        inner += `<path class="done" d="M0,${H} L${cut.join(' L')} L${(at * W).toFixed(1)},${H} Z"/>`;
      }
      inner += `<polyline class="line" points="${pts.join(' ')}"/>`;
      svg.innerHTML = inner;
      if (at != null) {
        // marker drawn as an HTML dot so it stays round under preserveAspectRatio=none
        const i = r.profile.findIndex(([d]) => d >= at * d0);
        const wrap = svg.parentElement;
        const m = document.createElement('span');
        m.className = 'here-dot';
        m.style.left = (at * 100).toFixed(2) + '%';
        m.style.top = ((Y(r.profile[Math.max(i, 0)][1]) / H) * 100).toFixed(2) + '%';
        wrap.appendChild(m);
      }
    });
    // map plate: <div class="mapplate" data-plate="route-id">
    document.querySelectorAll('[data-plate]').forEach((el) => {
      const r = D.routes[el.dataset.plate];
      const [bw, bh] = r.box;
      const pad = 140;
      const vb = [-pad, -pad, bw + pad * 2, bh + pad * 2];
      // graticule every 1 km in plan metres
      const k = 1000 / r.spanM; // svg units per metre
      let g = '';
      for (let x = vb[0] - (vb[0] % (1000 * k)); x < vb[0] + vb[2]; x += 1000 * k) g += `M${x.toFixed(1)},${vb[1]} V${vb[1] + vb[3]} `;
      for (let y = vb[1] - (vb[1] % (1000 * k)); y < vb[1] + vb[3]; y += 1000 * k) g += `M${vb[0]},${y.toFixed(1)} H${vb[0] + vb[2]} `;
      const pts = r.path.map((p) => p.join(',')).join(' ');
      const a = r.path[0], b = r.path[r.path.length - 1];
      el.innerHTML = `<svg viewBox="${vb.join(' ')}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <path class="grat" d="${g}"/>
        <polyline class="route" points="${pts}"/>
        <circle class="ends" cx="${a[0]}" cy="${a[1]}" r="${(bw + bh) / 120}"/>
        <circle class="ends" cx="${b[0]}" cy="${b[1]}" r="${(bw + bh) / 120}"/>
      </svg>`;
    });
    window.__mockReady = true;
  });
})();
