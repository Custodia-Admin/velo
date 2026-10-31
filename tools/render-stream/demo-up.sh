#!/bin/bash
# Bring the render-streaming spike up on cat-bed. Usage: demo-up.sh [gpu|velo] [W] [H] [FPS] [ENC]
#   gpu  = synthetic GPU scene with the latency marker (no CDP needed)
#   velo = the Velo demo ride from ~/velo-serve/dist (driven over CDP with uv + Playwright)
# Client: https://cat-bed.tail6f8715.ts.net:8443/velo-relay/client.html  (login ubuntu / password in ~/velo-stream/auth.conf)
# Stop with demo-down.sh. Nothing listens beyond 127.0.0.1 except WebRTC media (UDP, host candidates).
set -euo pipefail
cd "$(dirname "$0")"
MODE=${1:-gpu}; W=${2:-1920}; H=${3:-1080}; FPS=${4:-60}; ENC=${5:-h264enc}
systemctl --user reset-failed velo-relay 2>/dev/null || true
systemctl --user is-active -q velo-relay || systemd-run --user --collect --unit=velo-relay --working-directory="$PWD" /usr/bin/python3 "$PWD/relay.py" 8095
bash run-selkies.sh velo-render-a 8090 "$W" "$H" "$FPS" :20 "$ENC"
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:8090/ && break; sleep 1; done
if [ "$MODE" = gpu ]; then
  docker exec -d -u ubuntu velo-render-a /kiosk/start-chrome.sh 'http://127.0.0.1:8095/gpu-scene.html?agent=1&room=a' 9223
else
  docker exec -d -u ubuntu velo-render-a /kiosk/start-chrome.sh about:blank 9223
  sleep 5
  uv run -q --with playwright python server_page.py 9223 a 0
  uv run -q --with playwright python apply_patch.py 9223 kiosk/sample-memo.js
fi
tailscale serve status | grep -q ':8443' || { tailscale serve --bg --https=8443 http://127.0.0.1:8090; tailscale serve --bg --https=8443 --set-path=/velo-relay http://127.0.0.1:8095; }
echo "up: $MODE ${W}x${H}@${FPS} $ENC -> https://cat-bed.tail6f8715.ts.net:8443/velo-relay/client.html"
