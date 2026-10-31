#!/bin/bash
# Stop the render-streaming spike on cat-bed (containers + relay). Leaves velo-web and the :443 serve untouched.
# Add --serve to also drop the tailnet listeners on :8443/:8445.
docker rm -f velo-render-a velo-render-b 2>/dev/null
systemctl --user stop velo-relay 2>/dev/null
if [ "${1:-}" = --serve ]; then
  tailscale serve --https=8443 off 2>/dev/null
  tailscale serve --https=8445 off 2>/dev/null
fi
tailscale serve status
