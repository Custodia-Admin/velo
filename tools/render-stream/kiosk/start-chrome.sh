#!/bin/bash
# Runs inside the selkies container: one kiosk Chrome on the Selkies display, rendering on the GPU.
# Usage: /kiosk/start-chrome.sh <url> [cdp-port] [extra chrome flags...]
. "${XDG_RUNTIME_DIR:-/tmp/runtime-ubuntu}/container-env"
URL=${1:-http://127.0.0.1:4180/}; CDP=${2:-9223}; shift 2 || true
PROFILE=/tmp/chrome-velo-$CDP
pkill -f "user-data-dir=$PROFILE" 2>/dev/null; sleep 0.5
mkdir -p "$PROFILE"
eval "$(xdpyinfo -display "$DISPLAY" | awk '/dimensions:/{split($2,a,"x"); print "W="a[1]"; H="a[2]}')"
exec google-chrome-stable \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --disable-sync \
  --password-store=basic --disable-session-crashed-bubble --disable-infobars \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP" \
  --kiosk --start-fullscreen --window-position=0,0 --window-size="$W,$H" \
  --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy \
  --disable-background-timer-throttling --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion,Translate \
  --autoplay-policy=no-user-gesture-required --deny-permission-prompts --disable-notifications \
  "$@" "$URL" >"$PROFILE.log" 2>&1
