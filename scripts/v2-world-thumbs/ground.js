// Ground texture rasterisation: landcover / water / roads / route painted into
// colour + mask canvases for one world-space box. Colours are late-summer
// Umbria (stubble, ploughed earth, dry meadow, olive groves, oak woods).
import { mulberry32, hash2, fbm } from './world.js';

export const CLASS = {
  untagged: 0, farmland: 50, meadow: 90, orchard: 120, vineyard: 140, park: 160,
  residential: 190, industrial: 205, scrub: 225, forest: 255,
};
// landcover kinds: forest, scrub, grass, park, farmland, orchard, vineyard, residential, industrial, cemetery
const KIND_CLASS = [CLASS.forest, CLASS.scrub, CLASS.meadow, CLASS.park, CLASS.farmland, CLASS.orchard,
  CLASS.vineyard, CLASS.residential, CLASS.industrial, CLASS.park];
const KIND_ORDER = [4, 2, 3, 5, 6, 9, 1, 0, 8, 7];

const FIELD_COLS = [
  ['#c9ad74', 3], ['#bd9d62', 3], ['#d3bb85', 2], ['#8f7254', 2], ['#7d6248', 1.5], ['#a39762', 2],
  ['#7f8a4c', 1.3], ['#94904f', 1.2], ['#6f5e3e', 0.8], ['#b3a27a', 1.5], ['#9a8156', 1.5],
];
const MEADOW_COLS = ['#a39a5c', '#9c9a5e', '#aba164', '#8f8f52', '#b0a46a'];
const FOREST_COLS = ['#3f4b2c', '#36432a', '#46512f', '#3b4530', '#424e33'];
const SCRUB_COLS = ['#6e6b42', '#77714a', '#646540'];
const ROAD_STYLE = {
  // class index -> [colour, paved]
  0: ['#6c6a66', 1], 1: ['#6f6d68', 1], 2: ['#74716b', 1], 3: ['#7a766f', 1], 4: ['#817c74', 1],
  5: ['#8b857a', 1], 6: ['#88827a', 1], 7: ['#8b857c', 1], 8: ['#a09684', 1], 9: ['#8f887c', 0.8],
  10: ['#b4a382', 0.4], 11: ['#8d8579', 1], 12: ['#b8a888', 0.3], 13: ['#b9aa8a', 0.3], 14: ['#b4a78c', 0.5], 15: ['#a39a88', 0.6],
};

/** Field patchwork grid (shared with vegetation.js so hedgerows follow field edges). */
export const FIELD_CELL = 210;
export function fieldCorner(i, j) {
  return [i * FIELD_CELL + (hash2(i, j * 7 + 3) - 0.5) * FIELD_CELL * 0.7, j * FIELD_CELL + (hash2(i * 5 + 1, j) - 0.5) * FIELD_CELL * 0.7];
}

function pick(rng, list) {
  let tot = 0;
  for (const [, w] of list) tot += w;
  let r = rng() * tot;
  for (const [c, w] of list) { r -= w; if (r <= 0) return c; }
  return list[0][0];
}

function bboxOf(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i], y = ring[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0 / 10, y0 / 10, x1 / 10, y1 / 10];
}

function ringPath(ctx, ring) {
  ctx.moveTo(ring[0] / 10, ring[1] / 10);
  for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] / 10, ring[i + 1] / 10);
  ctx.closePath();
}

function linePath(ctx, p) {
  ctx.moveTo(p[0] / 10, p[1] / 10);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] / 10, p[i + 1] / 10);
}

let prepared = null;
function prepare(world) {
  if (prepared) return prepared;
  const lc = world.landcover.areas.map((a, i) => ({ ...a, bb: bboxOf(a.r[0]), i }));
  const wa = world.water.areas.map((a) => ({ ...a, bb: bboxOf(a.r[0]) }));
  const wl = world.water.lines.map((a) => ({ ...a, bb: bboxOf(a.p) }));
  const rd = world.roads.roads.map((a) => ({ ...a, bb: bboxOf(a.p) }));
  prepared = { lc, wa, wl, rd };
  return prepared;
}

function hits(bb, B, pad = 50) {
  return !(bb[2] < B.x0 - pad || bb[0] > B.x1 + pad || bb[3] < B.y0 - pad || bb[1] > B.y1 + pad);
}

function makePattern(ctx, size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  return ctx.createPattern(c, 'repeat');
}

/**
 * Rasterise a level. B = {x0,y0,x1,y1} world metres; w,h pixels.
 * Returns { color: canvas, mask: canvas, B, mpp }.
 */
export function rasterLevel(world, B, w, h, opts = {}) {
  const P = prepare(world);
  const mpp = (B.x1 - B.x0) / w;
  const color = document.createElement('canvas');
  color.width = w; color.height = h;
  const mask = document.createElement('canvas');
  mask.width = w; mask.height = h;
  // aux: per-field crop-row angle (R, 0..pi), row kind/spacing (G, 0 = none), field tone seed (B)
  const aux = document.createElement('canvas');
  aux.width = w; aux.height = h;
  const c = color.getContext('2d');
  const m = mask.getContext('2d');
  const x = aux.getContext('2d');
  x.imageSmoothingEnabled = false;
  const toWorld = (ctx) => ctx.setTransform(1 / mpp, 0, 0, -1 / mpp, -B.x0 / mpp, B.y1 / mpp);
  for (const ctx of [c, m, x]) { ctx.setTransform(1, 0, 0, 1, 0, 0); }
  c.fillStyle = '#b59d68'; c.fillRect(0, 0, w, h);
  m.fillStyle = 'rgb(0,0,0)'; m.fillRect(0, 0, w, h);
  x.fillStyle = 'rgb(0,0,128)'; x.fillRect(0, 0, w, h);
  toWorld(c); toWorld(m); toWorld(x);
  const auxFill = (pathFn, ang, kind, tone, rule) => {
    const a = (((ang % Math.PI) + Math.PI) % Math.PI) / Math.PI;
    x.fillStyle = `rgb(${Math.round(a * 255)},${kind},${Math.round(tone * 255)})`;
    x.beginPath(); pathFn(x); x.fill(rule);
  };

  // ---------- background patchwork of fields (untagged land and farmland) ----------
  const cellM = FIELD_CELL;
  const gx0 = Math.floor(B.x0 / cellM) - 1, gx1 = Math.ceil(B.x1 / cellM) + 1;
  const gy0 = Math.floor(B.y0 / cellM) - 1, gy1 = Math.ceil(B.y1 / cellM) + 1;
  const jit = fieldCorner;
  for (let i = gx0; i < gx1; i++) {
    for (let j = gy0; j < gy1; j++) {
      const a = jit(i, j), b = jit(i + 1, j), cc = jit(i + 1, j + 1), d = jit(i, j + 1);
      const rng = mulberry32((i * 92821) ^ (j * 68917) ^ 0x5bd1e995);
      // split the quad into 1-3 strips along its longer axis
      const n = 1 + Math.floor(rng() * 3);
      const horiz = rng() < 0.5;
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const L = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        let quad;
        if (horiz) quad = [L(a, d, t0), L(b, cc, t0), L(b, cc, t1), L(a, d, t1)];
        else quad = [L(a, b, t0), L(a, b, t1), L(d, cc, t1), L(d, cc, t0)];
        c.beginPath();
        c.moveTo(quad[0][0], quad[0][1]);
        for (let q = 1; q < 4; q++) c.lineTo(quad[q][0], quad[q][1]);
        c.closePath();
        const fc = pick(rng, FIELD_COLS);
        c.fillStyle = fc;
        c.fill();
        {
          // crop rows run along one side of the strip; kind 1..255 encodes spacing + strength
          const ang = Math.atan2(quad[1][1] - quad[0][1], quad[1][0] - quad[0][0]) + (rng() < 0.6 ? 0 : Math.PI / 2);
          const ploughed = fc === '#8f7254' || fc === '#7d6248' || fc === '#6f5e3e';
          const kind = rng() < 0.18 && !ploughed ? 0 : ploughed ? 200 + Math.floor(rng() * 50) : 40 + Math.floor(rng() * 140);
          const tone = rng();
          x.fillStyle = `rgb(${Math.round(((((ang % Math.PI) + Math.PI) % Math.PI) / Math.PI) * 255)},${kind},${Math.round(tone * 255)})`;
          x.beginPath(); x.moveTo(quad[0][0], quad[0][1]); for (let q = 1; q < 4; q++) x.lineTo(quad[q][0], quad[q][1]); x.closePath(); x.fill();
        }
        // field margins: thin grassy / shrubby edges
        c.strokeStyle = rng() < 0.35 ? 'rgba(70,72,40,0.55)' : 'rgba(150,140,95,0.45)';
        c.lineWidth = Math.max(mpp * 0.8, 2.0);
        c.stroke();
      }
    }
  }

  // ---------- wild woods / scrub on steep untagged slopes (precomputed layer) ----------
  if (opts.wild) {
    const W = opts.wild;
    for (const [ctx, img] of [[c, W.color], [m, W.mask]]) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (W.x0 - B.x0) / mpp, (B.y1 - W.y1) / mpp, (W.x1 - W.x0) / mpp, (W.y1 - W.y0) / mpp);
      ctx.restore();
    }
  }

  // ---------- landcover polygons ----------
  const olive = makePattern(c, 32, (g, s) => {
    g.fillStyle = 'rgba(70,82,50,0.85)'; g.beginPath(); g.arc(s / 2, s / 2, s * 0.26, 0, Math.PI * 2); g.fill();
  });
  const vine = makePattern(c, 32, (g, s) => {
    g.fillStyle = 'rgba(78,92,44,0.8)'; g.fillRect(0, s * 0.3, s, s * 0.38);
  });
  const byKind = [...P.lc].filter((a) => hits(a.bb, B)).sort((p, q) => KIND_ORDER.indexOf(p.k) - KIND_ORDER.indexOf(q.k));
  for (const a of byKind) {
    const rng = mulberry32(a.i * 2654435761);
    const path = () => { for (const r of a.r) ringPath(c, r); };
    c.beginPath(); path();
    m.beginPath(); for (const r of a.r) ringPath(m, r);
    const cls = KIND_CLASS[a.k];
    m.fillStyle = `rgb(0,0,${cls})`;
    m.fill('evenodd');
    if (a.k !== 4) {
      const rowAng = rng() * Math.PI;
      const kind = a.k === 5 ? 30 : 0; // faint orchard mowing rows (vine rows are painted)
      auxFill((ctx) => { for (const r of a.r) ringPath(ctx, r); }, rowAng, kind, rng(), 'evenodd');
    }
    switch (a.k) {
      case 4: // farmland: keep the patchwork underneath, slight unify tint
        c.fillStyle = 'rgba(190,160,100,0.10)'; c.fill('evenodd'); break;
      case 0: c.fillStyle = FOREST_COLS[Math.floor(rng() * FOREST_COLS.length)]; c.fill('evenodd'); break;
      case 1: c.fillStyle = SCRUB_COLS[Math.floor(rng() * SCRUB_COLS.length)]; c.fill('evenodd'); break;
      case 2: c.fillStyle = MEADOW_COLS[Math.floor(rng() * MEADOW_COLS.length)]; c.fill('evenodd'); break;
      case 3: c.fillStyle = '#7f8748'; c.fill('evenodd'); break;
      case 9: c.fillStyle = '#8d8a74'; c.fill('evenodd'); break;
      case 5: { // orchard / olive grove: dry grass ground + tree rows
        c.fillStyle = ['#a99f6c', '#9f9664', '#b0a473'][Math.floor(rng() * 3)]; c.fill('evenodd');
        const sp = 7;
        olive.setTransform(new DOMMatrix().rotateSelf(0, 0, rng() * 90).scaleSelf(sp / 32, sp / 32));
        if (mpp < 1.2) break;
        c.save(); c.clip('evenodd'); c.fillStyle = olive; c.globalAlpha = mpp > 3 ? 0.55 : 0.6;
        c.fillRect(a.bb[0], a.bb[1], a.bb[2] - a.bb[0], a.bb[3] - a.bb[1]); c.restore();
        break;
      }
      case 6: {
        c.fillStyle = '#9d8b5f'; c.fill('evenodd');
        const sp = 2.6;
        vine.setTransform(new DOMMatrix().rotateSelf(0, 0, rng() * 180).scaleSelf(sp / 32, sp / 32));
        c.save(); c.clip('evenodd'); c.fillStyle = vine; c.globalAlpha = mpp > 2 ? 0.6 : 0.9;
        c.fillRect(a.bb[0], a.bb[1], a.bb[2] - a.bb[0], a.bb[3] - a.bb[1]); c.restore();
        break;
      }
      case 7: c.fillStyle = ['#9d927c', '#a29684', '#968f78'][Math.floor(rng() * 3)]; c.fill('evenodd'); break;
      case 8: c.fillStyle = '#a19e96'; c.fill('evenodd'); break;
    }
  }

  // ---------- buildings: footprint shadow halo (AO) ----------
  if (mpp < 2.5 && world.buildings) {
    const bd = world.buildings;
    c.fillStyle = 'rgba(60,50,40,0.35)';
    c.beginPath();
    for (let i = 0; i < bd.count; i++) {
      const s = bd.start[i], e = bd.start[i + 1];
      const x = bd.xy[s * 2], y = bd.xy[s * 2 + 1];
      if (x < B.x0 - 50 || x > B.x1 + 50 || y < B.y0 - 50 || y > B.y1 + 50) continue;
      c.moveTo(x, y);
      for (let k = s + 1; k < e; k++) c.lineTo(bd.xy[k * 2], bd.xy[k * 2 + 1]);
      c.closePath();
    }
    c.save(); c.filter = `blur(${Math.max(1, 1.2 / mpp)}px)`; c.lineWidth = 2.5; c.strokeStyle = 'rgba(60,50,40,0.25)'; c.stroke(); c.fill(); c.restore();
  }

  // ---------- water ----------
  c.fillStyle = '#4b5236';
  m.fillStyle = 'rgb(255,0,90)';
  for (const a of P.wa) {
    if (!hits(a.bb, B)) continue;
    c.beginPath(); for (const r of a.r) ringPath(c, r); c.fill('evenodd');
    m.beginPath(); for (const r of a.r) ringPath(m, r); m.fill('evenodd');
  }
  c.lineCap = m.lineCap = 'round'; c.lineJoin = m.lineJoin = 'round';
  for (const l of P.wl) {
    if (!hits(l.bb, B)) continue;
    const wdt = l.w ?? world.water.lineWidths[l.k];
    // muddy banks
    c.strokeStyle = 'rgba(105,98,70,0.6)'; c.lineWidth = wdt + 4;
    c.beginPath(); linePath(c, l.p); c.stroke();
    c.strokeStyle = '#4b5236'; c.lineWidth = Math.max(wdt, mpp * 0.7);
    c.beginPath(); linePath(c, l.p); c.stroke();
    m.strokeStyle = l.k === 2 ? 'rgb(160,0,90)' : 'rgb(255,0,90)'; m.lineWidth = Math.max(wdt, mpp * 0.7);
    m.beginPath(); linePath(m, l.p); m.stroke();
  }

  // ---------- roads ----------
  const roads = P.rd.filter((r) => hits(r.bb, B)).sort((p, q) => q.c - p.c);
  for (const r of roads) {
    if (r.f & 2) continue; // tunnel
    const cls = world.roads.classes[r.c];
    const wdt = r.w ?? world.roads.widths[r.c];
    if (mpp > 2.5 && (cls === 'footway' || cls === 'path' || cls === 'steps' || cls === 'bridleway')) continue;
    let [col, paved] = ROAD_STYLE[r.c] ?? ['#8a857c', 1];
    if (r.f & 4) { col = '#b4a382'; paved = 0.4; }
    const px = wdt / mpp;
    c.globalAlpha = px < 1 ? Math.max(0.25, px) * 0.85 : 0.92;
    // soft shoulder
    if (mpp < 1.5 && paved > 0.7) {
      c.strokeStyle = 'rgba(150,140,110,0.5)'; c.lineWidth = wdt + 1.6;
      c.beginPath(); linePath(c, r.p); c.stroke();
    }
    c.strokeStyle = col; c.lineWidth = Math.max(wdt, mpp * 0.9);
    c.beginPath(); linePath(c, r.p); c.stroke();
    c.globalAlpha = 1;
    m.strokeStyle = `rgb(0,${Math.round(paved * 255)},60)`; m.lineWidth = Math.max(wdt, mpp * 0.9);
    m.beginPath(); linePath(m, r.p); m.stroke();
  }

  // ---------- the ride route (cycle path surface) ----------
  if (opts.routes) {
    for (const rt of opts.routes) {
      const draw = (ctx, style, width) => {
        ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
        ctx.moveTo(rt.x[0], rt.y[0]);
        for (let i = 1; i < rt.x.length; i++) ctx.lineTo(rt.x[i], rt.y[i]);
        ctx.stroke();
      };
      if (mpp < 1.5) draw(c, 'rgba(160,150,120,0.6)', 4.6);
      draw(c, '#86807a', Math.max(3.2, mpp));
      draw(m, 'rgb(0,255,60)', Math.max(3.2, mpp));
    }
  }
  return { color, mask, aux, B, mpp };
}

/**
 * Woods and scrub on steep untagged ground: Umbrian hillsides that OSM leaves
 * blank are mostly oak wood. Painted under the landcover polygons, so tagged
 * fields stay fields. Built at half the heightfield cell size.
 */
export function makeWildLayer(hf) {
  const sub = 2;
  const W = (hf.cols - 1) * sub + 1, H = (hf.rows - 1) * sub + 1;
  const cell = hf.cell / sub;
  // per-node weight
  const wN = new Float32Array(hf.cols * hf.rows);
  for (let r = 0; r < hf.rows; r++) {
    for (let c = 0; c < hf.cols; c++) {
      const gx = (hf.node(c + 1, r) - hf.node(c - 1, r)) / (2 * hf.cell);
      const gy = (hf.node(c, r + 1) - hf.node(c, r - 1)) / (2 * hf.cell);
      const slope = 1 - 1 / Math.sqrt(1 + gx * gx + gy * gy);
      const x = hf.xMin + c * hf.cell, y = hf.yMax - r * hf.cell;
      const n = fbm(x * 0.004, y * 0.004, 4);
      const s = Math.max(0, Math.min(1, (slope - 0.025) / 0.09));
      wN[r * hf.cols + c] = Math.max(0, Math.min(1, s * s * (3 - 2 * s) * 1.25 + (n - 0.6) * 2.6));
    }
  }
  const color = document.createElement('canvas'); color.width = W; color.height = H;
  const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
  const ci = color.getContext('2d').createImageData(W, H);
  const mi = mask.getContext('2d').createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const fr = py / sub, r0 = Math.min(hf.rows - 2, Math.floor(fr)), ty = fr - r0;
    for (let px = 0; px < W; px++) {
      const fc = px / sub, c0 = Math.min(hf.cols - 2, Math.floor(fc)), tx = fc - c0;
      const i0 = r0 * hf.cols + c0;
      const w = (wN[i0] * (1 - tx) + wN[i0 + 1] * tx) * (1 - ty) + (wN[i0 + hf.cols] * (1 - tx) + wN[i0 + hf.cols + 1] * tx) * ty;
      const x = hf.xMin + px * cell, y = hf.yMax - py * cell;
      const e = w + (fbm(x * 0.05, y * 0.05, 2) - 0.5) * 0.55;
      const a = Math.max(0, Math.min(1, (e - 0.42) / 0.16));
      const o = (py * W + px) * 4;
      const tone = fbm(x * 0.01 + 7, y * 0.01, 2);
      const scrub = tone < 0.42;
      ci.data[o] = scrub ? 104 : 58 + tone * 14; ci.data[o + 1] = scrub ? 102 : 72 + tone * 12; ci.data[o + 2] = scrub ? 64 : 42 + tone * 6;
      ci.data[o + 3] = Math.round(a * 255);
      mi.data[o] = 0; mi.data[o + 1] = 0; mi.data[o + 2] = scrub ? 228 : 255; mi.data[o + 3] = Math.round(a * 255);
    }
  }
  color.getContext('2d').putImageData(ci, 0, 0);
  mask.getContext('2d').putImageData(mi, 0, 0);
  return { color, mask, x0: hf.xMin, x1: hf.xMax, y0: hf.yMin, y1: hf.yMax };
}

/** CPU lookup of mask classes from a rasterised level (image data cached). */
export function maskSampler(level) {
  const { mask, B, mpp } = level;
  const ctx = mask.getContext('2d');
  const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
  const W = mask.width, H = mask.height;
  return (x, y) => {
    const px = Math.floor((x - B.x0) / mpp), py = Math.floor((B.y1 - y) / mpp);
    if (px < 0 || py < 0 || px >= W || py >= H) return null;
    const i = (py * W + px) * 4;
    return { water: data[i], road: data[i + 1], cls: data[i + 2] };
  };
}

export { fbm };
