#!/bin/bash
# Two concurrent render sessions (household: TV + tablet). Usage: run_dual.sh <label> <W> <H> <FPS> [secs] [srcA] [srcB]
# src: gpu (synthetic GPU scene) | velo (Velo demo ride)
set -u
cd "$(dirname "$0")"
L=$1; W=$2; H=$3; FPS=$4; SECS=${5:-30}; SA=${6:-gpu}; SB=${7:-gpu}
PY="uv run -q --with playwright python"
ssh cat-bed 'tailscale serve --bg --https=8445 http://127.0.0.1:8091 >/dev/null; tailscale serve --bg --https=8445 --set-path=/velo-relay http://127.0.0.1:8095 >/dev/null'
ssh cat-bed "bash ~/velo-stream/run-selkies.sh velo-render-a 8090 $W $H $FPS :20; bash ~/velo-stream/run-selkies.sh velo-render-b 8091 $W $H $FPS :21" >/dev/null
sleep 15
ssh cat-bed 'docker exec -d -u ubuntu velo-render-a /kiosk/start-chrome.sh about:blank 9223; docker exec -d -u ubuntu velo-render-b /kiosk/start-chrome.sh about:blank 9224'
sleep 6
src() { # port room src
  if [ "$3" = velo ]; then $PY server_page.py "$1" "$2" 0 | grep -E '^\{'; $PY apply_patch.py "$1" kiosk/sample-memo.js
  else $PY server_generic.py "$1" "$2" http://127.0.0.1:8095/gpu-scene.html ws://127.0.0.1:8095/ws | tail -1; fi
}
src 9223 a "$SA" & src 9224 b "$SB" & wait
ssh cat-bed 'docker exec -d -u ubuntu velo-render-a /kiosk/start-client-chrome.sh 9230; docker exec -d -u ubuntu velo-render-b /kiosk/start-client-chrome.sh 9231'
sleep 5
ssh cat-bed "bash ~/velo-stream/host_sample.sh $((SECS+10)) $L" > "host-$L.txt" 2>&1 &
HS=$!
CDP_CLIENT=9230 $PY client_measure.py "$L-a" "$SECS" client a 0 https://cat-bed.tail6f8715.ts.net:8443 | grep FINAL | sed 's/^/A /' &
CDP_CLIENT=9231 $PY client_measure.py "$L-b" "$SECS" client b 0 https://cat-bed.tail6f8715.ts.net:8445 | grep FINAL | sed 's/^/B /' &
wait %2 %3 2>/dev/null; wait
$PY render_stats.py 9223 5 | tail -1 | sed 's/^/RENDER-A /'
$PY render_stats.py 9224 5 | tail -1 | sed 's/^/RENDER-B /'
grep HOST "host-$L.txt"
