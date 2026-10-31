#!/usr/bin/env bash
# Interleaved before/after measurement: same machine state for both builds.
set -u
cd /home/federicob/Projects/velo/.worktrees/perf-camera
OUT=~/.hermes/cache/scratch/velo-perf/ab
mkdir -p "$OUT"
export HEADLESS=1 STARTUP_S=20 STEADY_S=30
run() { # label base [quality]
  local label=$1 base=$2 q=${3:-}
  if [ -n "$q" ]; then QUALITY=$q uv run --with playwright python scripts/perf-ride.py "$OUT/$label.json" "$base" > "$OUT/$label.log" 2>&1
  else env -u QUALITY uv run --with playwright python scripts/perf-ride.py "$OUT/$label.json" "$base" > "$OUT/$label.log" 2>&1; fi
  echo "done $label $(date +%T) load $(cut -d' ' -f1 /proc/loadavg)" >> "$OUT/progress.txt"
}
CONFIGS="empty:terrain=0&imagery=0&photoreal=0;terrain+bing:photoreal=0;photoreal:" SETTLE_S=10 WINDOW_S=8 \
  uv run --with playwright python scripts/perf-bare.py ~/.hermes/cache/scratch/velo-perf-after-dist http://localhost:4192 > "$OUT/bare-pre.txt" 2>&1
for round in 1 2; do
  run "r$round-before-default" http://localhost:4191
  run "r$round-after-default" http://localhost:4192
  run "r$round-before-high" http://localhost:4191 high
  run "r$round-after-high" http://localhost:4192 high
  run "r$round-before-medium" http://localhost:4191 medium
  run "r$round-after-medium" http://localhost:4192 medium
done
CONFIGS="empty:terrain=0&imagery=0&photoreal=0;terrain+bing:photoreal=0;photoreal:" SETTLE_S=10 WINDOW_S=8 \
  uv run --with playwright python scripts/perf-bare.py ~/.hermes/cache/scratch/velo-perf-after-dist http://localhost:4192 > "$OUT/bare-post.txt" 2>&1
echo ALLDONE >> "$OUT/progress.txt"
