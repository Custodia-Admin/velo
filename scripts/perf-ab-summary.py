"""Summarise the interleaved before/after runs from scripts/perf-ab.sh.
Usage: python3 scripts/perf-ab-summary.py <ab-dir>
Prints per config × view: steady fps, p50/p95 frame time, jank share and
worst 1 s fps for each round, then the median across rounds.
"""
import json, pathlib, statistics, sys

d = pathlib.Path(sys.argv[1])
rows = {}
for f in sorted(d.glob("r*-*.json")):
    rnd, phase, cfg = f.stem.split("-", 2)
    data = json.loads(f.read_text())
    for view, r in data["runs"].items():
        for win in ("startup", "steady"):
            s = r.get(win, {})
            rows.setdefault((cfg, view, win, phase), []).append(
                (s.get("fps"), s.get("p50_ms"), s.get("p95_ms"), s.get("jank33_pct"), s.get("worst_1s_fps")))

print(f"{'config':8s} {'view':5s} {'window':8s} {'build':7s} {'fps (median of rounds)':>24s}  p50   p95  jank%  worst1s  rounds-fps")
for key in sorted(rows):
    cfg, view, win, phase = key
    vals = rows[key]
    med = lambda i: statistics.median(v[i] for v in vals if v[i] is not None) if any(v[i] is not None for v in vals) else float("nan")
    print(f"{cfg:8s} {view:5s} {win:8s} {phase:7s} {med(0):24.1f} {med(1):5.0f} {med(2):5.0f} {med(3):6.0f} {med(4):7.0f}   {[v[0] for v in vals]}")
