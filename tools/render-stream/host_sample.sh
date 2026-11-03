#!/bin/bash
# Sample GPU/NVENC and container CPU on cat-bed for N seconds. Usage: host_sample.sh <seconds> <label>
N=${1:-20}; L=${2:-run}; OUT=~/velo-stream/samples/$L; mkdir -p "$OUT"
nvidia-smi --query-gpu=timestamp,utilization.gpu,utilization.encoder,utilization.decoder,encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency,memory.used,power.draw,clocks.gr,temperature.gpu --format=csv,noheader -l 1 > "$OUT/nvsmi.csv" &
NV=$!
( for i in $(seq 1 $((N/5))); do docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' | grep velo-render; sleep 4; done ) > "$OUT/docker.csv" &
DS=$!
nvidia-smi dmon -s ue -c "$N" > "$OUT/dmon.txt" 2>&1
kill $NV 2>/dev/null; wait $DS 2>/dev/null
uptime > "$OUT/uptime.txt"
python3 - "$OUT" <<'EOF'
import sys, csv, statistics as st
out = sys.argv[1]
rows = [r for r in csv.reader(open(out + '/nvsmi.csv')) if len(r) > 5]
def col(i):
    v = []
    for r in rows:
        try: v.append(float(r[i].strip().split()[0]))
        except Exception: pass
    return v
names = ['gpu%', 'enc%', 'dec%', 'encSessions', 'encAvgFps', 'encAvgLatencyUs', 'memMiB', 'powerW', 'clockMHz', 'tempC']
summ = {n: (round(st.mean(col(i + 1)), 1) if col(i + 1) else None) for i, n in enumerate(names)}
summ['gpu%max'] = max(col(1)) if col(1) else None
summ['enc%max'] = max(col(2)) if col(2) else None
cpu = {}
for line in open(out + '/docker.csv'):
    p = line.strip().split(',')
    if len(p) >= 2:
        cpu.setdefault(p[0], []).append(float(p[1].rstrip('%')))
summ['containerCpu%'] = {k: round(st.mean(v), 1) for k, v in cpu.items()}
summ['load'] = open(out + '/uptime.txt').read().split('load average:')[-1].strip()
print('HOST', summ)
EOF
