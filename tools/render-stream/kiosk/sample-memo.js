// Spike-only runtime patch: memoise Scene.sampleHeight (a synchronous GPU pick + readPixels that the
// avatar calls every frame). Key ~5 m grid, TTL 1 s. Proves the per-frame pick is the frame-rate cap.
(() => {
  const C = window.Cesium; if (!C || !C.Scene) return 'no Cesium global';
  const proto = C.Scene.prototype; if (proto.__veloSampleMemo) return 'already';
  const orig = proto.sampleHeight; const cache = new Map(); let real = 0, hits = 0;
  proto.sampleHeight = function (pos, exclude, width) {
    const k = Math.round(C.Math.toDegrees(pos.longitude) * 20000) + ':' + Math.round(C.Math.toDegrees(pos.latitude) * 20000);
    const t = performance.now(); const c = cache.get(k);
    if (c && t - c.t < 1000) { hits++; return c.v; }
    real++; const v = orig.call(this, pos, exclude, width); cache.set(k, { v, t });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return v;
  };
  proto.__veloSampleMemo = () => ({ real, hits });
  return 'patched';
})();
