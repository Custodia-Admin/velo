#!/bin/bash
# Runs inside the selkies container: a headless measuring CLIENT Chrome (loopback client on cat-bed).
CDP=${1:-9230}
PROFILE=/tmp/chrome-client-$CDP
pkill -f "user-data-dir=$PROFILE" 2>/dev/null; sleep 0.5; mkdir -p "$PROFILE"
exec google-chrome-stable --headless=new --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP" \
  --ignore-gpu-blocklist --enable-gpu --use-angle=vulkan --enable-features=Vulkan \
  --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  --window-size=1920,1080 about:blank >"$PROFILE.log" 2>&1
