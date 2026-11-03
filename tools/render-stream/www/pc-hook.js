// Spike: capture RTCPeerConnections (injected as an init script into every frame) and a stats reader.
(() => {
  const O = window.RTCPeerConnection; if (!O || window.__pcs) return;
  window.__pcs = [];
  const W = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; };
  W.prototype = O.prototype; Object.setPrototypeOf(W, O);
  window.RTCPeerConnection = W;
  window.__unlockStats = async () => { try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); return 'ok'; } catch (e) { return String(e); } };
  window.__rtcStats = async () => {
    const pc = window.__pcs.filter((p) => p.connectionState !== 'closed').pop(); if (!pc) return null;
    const rep = await pc.getStats(); const by = {}; rep.forEach((s) => { by[s.id] = s; });
    const v = [...rep.values()].find((s) => s.type === 'inbound-rtp' && s.kind === 'video'); if (!v) return { state: pc.connectionState };
    const pair = [...rep.values()].find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
    const lc = pair && by[pair.localCandidateId], rc = pair && by[pair.remoteCandidateId];
    const codec = v.codecId && by[v.codecId];
    return {
      codec: codec && codec.mimeType, fmtp: codec && codec.sdpFmtpLine, decoder: v.decoderImplementation, hwDecoder: v.powerEfficientDecoder,
      fw: v.frameWidth, fh: v.frameHeight, fps: v.framesPerSecond, framesDecoded: v.framesDecoded, framesDropped: v.framesDropped, framesReceived: v.framesReceived,
      decodeMsAvg: v.framesDecoded ? 1000 * v.totalDecodeTime / v.framesDecoded : null,
      jitterBufMsAvg: v.jitterBufferEmittedCount ? 1000 * v.jitterBufferDelay / v.jitterBufferEmittedCount : null,
      jitterBufTargetMsAvg: v.jitterBufferEmittedCount && v.jitterBufferTargetDelay ? 1000 * v.jitterBufferTargetDelay / v.jitterBufferEmittedCount : null,
      packetsLost: v.packetsLost, nack: v.nackCount, pli: v.pliCount, freezes: v.freezeCount, freezeS: v.totalFreezesDuration, kbps: null, bytes: v.bytesReceived, t: v.timestamp,
      rttMs: pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      local: lc && `${lc.candidateType} ${lc.protocol} ${lc.address}:${lc.port}`, remote: rc && `${rc.candidateType} ${rc.protocol} ${rc.address}:${rc.port}`,
    };
  };
})();
