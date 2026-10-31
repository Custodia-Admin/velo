#!/usr/bin/env bash
# Velo render-streaming spike: one Selkies 2.1 session (Xvfb on the GPU + Chrome + NVENC + WebRTC).
# Usage: run-selkies.sh <name> <port> <width> <height> [fps] [display] [encoder: h264enc|av1enc|h265enc]
#   e.g. run-selkies.sh velo-render-a 8090 1920 1080 60 :20
# Tailnet-only: Selkies binds 127.0.0.1; expose with `tailscale serve --bg --https=<p> http://127.0.0.1:<port>`.
set -euo pipefail
NAME=${1:-velo-render-a}; PORT=${2:-8090}; W=${3:-1920}; H=${4:-1080}; FPS=${5:-60}; DISP=${6:-:20}; ENC=${7:-${ENC:-h264enc}}
IMAGE=ghcr.io/selkies-project/selkies/desktop@sha256:558fb9d6d97697f8861022bc2594e930e0bb669025360e87022b86155e1aec2e  # 2.1.0-ubuntu26.04
cd "$(dirname "$0")"
# NVIDIA's GBM backend (libnvidia-allocator) is not injected by nvidia-container-toolkit 1.20.1 on this
# host; without it Xvfb cannot put the screen on the GPU ("Failed to allocate GBM buffer") and the
# session renders through Zink with a CPU readback. Mount the host's copy (follows driver upgrades).
ALLOC=$(readlink -f /usr/lib/libnvidia-allocator.so.1)
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  --runtime nvidia --gpus all --network host --shm-size=2g \
  --env-file auth.conf \
  -e TZ=Europe/Rome \
  -e DISPLAY="$DISP" \
  -e SELKIES_PORT="$PORT" \
  -e SELKIES_ENABLE_HTTPS=false \
  -e SELKIES_MODE=webrtc -e SELKIES_ENABLE_DUAL_MODE=true \
  -e SELKIES_TURN_HOST=127.0.0.1 -e SELKIES_TURN_PORT=3478 \
  -e SELKIES_TURN_USERNAME=unused -e SELKIES_TURN_PASSWORD=unused \
  -e SELKIES_RTC_CONFIG_JSON=/cfg/rtc.json \
  -e SELKIES_ENCODER="$ENC" \
  -e SELKIES_FRAMERATE="$FPS" \
  -e SELKIES_VIDEO_BITRATE=20000 \
  -e SELKIES_CONGESTION_CONTROL=false \
  -e SELKIES_MANUAL_WIDTH="$W" -e SELKIES_MANUAL_HEIGHT="$H" \
  -e DISPLAY_SIZEW="$W" -e DISPLAY_SIZEH="$H" -e DISPLAY_REFRESH="$FPS" \
  -e SELKIES_AUDIO_ENABLED=false -e SELKIES_SCALING_DPI=96 \
  -e SELKIES_FILE_TRANSFERS=none -e SELKIES_ENABLE_CLIPBOARD=false -e SELKIES_PRINTING_ENABLED=false \
  -e START_LXQT=false \
  -v "$PWD/rtc.json:/cfg/rtc.json:ro" \
  -v "$PWD/kiosk:/kiosk:ro" \
  -v "$PWD/selkies-entrypoint.sh:/etc/selkies-entrypoint.sh:ro" \
  -v "$ALLOC:/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1:ro" \
  -v "$ALLOC:/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so:ro" \
  "$IMAGE"
echo "started $NAME on 127.0.0.1:$PORT ${W}x${H}@${FPS} display $DISP"
