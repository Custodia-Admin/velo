#!/bin/bash
# One-time setup of the render-streaming spike on cat-bed. Run from the deployed dir:
#   rsync -a tools/render-stream/ cat-bed:velo-stream/ && ssh cat-bed 'bash ~/velo-stream/setup.sh'
# Creates the basic-auth secret (auth.conf, 0600, never committed), the no-STUN/TURN rtc.json,
# a patched copy of Selkies' entrypoint that binds 127.0.0.1 instead of every interface,
# pulls the pinned image, and puts the tailnet-only HTTPS listener on :8443.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=ghcr.io/selkies-project/selkies/desktop@sha256:558fb9d6d97697f8861022bc2594e930e0bb669025360e87022b86155e1aec2e  # 2.1.0-ubuntu26.04
docker pull -q "$IMAGE" >/dev/null
if [ ! -f auth.conf ]; then
  umask 077
  printf 'SELKIES_BASIC_AUTH_PASSWORD=%s\n' "$(tr -dc A-Za-z0-9 </dev/urandom | head -c 20)" | tee auth.conf >/dev/null
fi
# Empty ICE server list: host candidates only (LAN / tailnet), no Google STUN, no TURN.
echo '{"iceServers":[]}' | tee rtc.json >/dev/null
# Selkies 2.1's /etc/selkies-entrypoint.sh hard-codes --public (0.0.0.0); serve on loopback only.
docker run --rm --entrypoint cat "$IMAGE" /etc/selkies-entrypoint.sh \
  | sed 's/exec selkies --public /exec selkies --addr=127.0.0.1 /' | tee selkies-entrypoint.sh >/dev/null
chmod 755 selkies-entrypoint.sh ./*.sh kiosk/*.sh
grep -q 'addr=127.0.0.1' selkies-entrypoint.sh || { echo 'entrypoint patch did not apply (image changed?)' >&2; exit 1; }
# Tailnet-only HTTPS: / -> Selkies (session a), /velo-relay -> state relay + test pages.
tailscale serve --bg --https=8443 http://127.0.0.1:8090 >/dev/null
tailscale serve --bg --https=8443 --set-path=/velo-relay http://127.0.0.1:8095 >/dev/null
tailscale serve status
