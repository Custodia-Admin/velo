#!/bin/bash
# One measurement run. Usage: run_case.sh <label> <W> <H> <FPS> <source: velo|aquarium|URL> [secs] [client: laptop|host|none] [headed]
: "${RENDER_HOST:?set RENDER_HOST to the render box ssh alias (tools/render-stream/README.md)}"
: "${RENDER_URL:?set RENDER_URL to its tailnet-only https base, e.g. https://render-box.example.ts.net:8443}"
set -u
cd "$(dirname "$0")"
L=$1; W=$2; H=$3; FPS=$4; SRC=$5; SECS=${6:-30}; CLIENT=${7:-laptop}; HEADED=${8:-0}
PY="uv run -q --with playwright python"
ssh "$RENDER_HOST" "bash ~/velo-stream/run-selkies.sh velo-render-a 8090 $W $H $FPS :20 ${ENC:-h264enc}" >/dev/null
sleep 14
ssh "$RENDER_HOST" "docker exec -d -u ubuntu velo-render-a /kiosk/start-chrome.sh about:blank 9223 ${CHROME_EXTRA:-}"
sleep 6
if [ "$SRC" = velo ]; then
  $PY server_page.py 9223 a 0 | grep -E '^\{' ; $PY apply_patch.py 9223 kiosk/sample-memo.js
else
  [ "$SRC" = aquarium ] && SRC='https://webglsamples.org/aquarium/aquarium.html?numFish=10000'
  [ "$SRC" = gpu ] && SRC='http://127.0.0.1:8095/gpu-scene.html'
  RELAY=wss://${RENDER_URL#https://}/velo-relay/ws; case "$SRC" in http://127.0.0.1*) RELAY=ws://127.0.0.1:8095/ws;; esac
  $PY server_generic.py 9223 a "$SRC" "$RELAY" | tail -1
fi
sleep 3
[ -n "${BUSY:-}" ] && ssh "$RENDER_HOST" "for i in 1 2; do timeout $((SECS+15)) nice -n 10 python3 -c \"while 1: pass\" & done; wait" &
ssh "$RENDER_HOST" "bash ~/velo-stream/host_sample.sh $((SECS+10)) $L" > "host-$L.txt" 2>&1 &
HS=$!
if [ "$CLIENT" = laptop ]; then
  $PY client_measure.py "$L" "$SECS" client a "$HEADED" | grep FINAL
elif [ "$CLIENT" = host ]; then
  ssh "$RENDER_HOST" 'docker exec -d -u ubuntu velo-render-a /kiosk/start-client-chrome.sh 9230'; sleep 4
  CDP_CLIENT=9230 $PY client_measure.py "$L" "$SECS" client a | grep FINAL
fi
$PY render_stats.py 9223 5 | tail -1 | sed 's/^/RENDER /'
wait $HS; grep HOST "host-$L.txt"
