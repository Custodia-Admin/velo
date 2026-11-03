"""Print a .cpuprofile as a top-down call tree (inclusive ms), pruned.
Usage: python3 scripts/cpuprofile-tree.py <file.cpuprofile> [min_ms=80] [max_depth=40]
"""
import json, sys

prof = json.load(open(sys.argv[1]))
MIN = float(sys.argv[2]) if len(sys.argv) > 2 else 80
DEPTH = int(sys.argv[3]) if len(sys.argv) > 3 else 40
nodes = {n["id"]: n for n in prof["nodes"]}
self_ms = {}
for sid, dt in zip(prof["samples"], prof["timeDeltas"]):
    self_ms[sid] = self_ms.get(sid, 0) + dt / 1000
incl = {}


def total(i):
    if i in incl:
        return incl[i]
    t = self_ms.get(i, 0) + sum(total(c) for c in nodes[i].get("children", []))
    incl[i] = t
    return t


root = prof["nodes"][0]["id"]
total(root)


def name(n):
    cf = n["callFrame"]
    return f'{cf["functionName"] or "(anon)"} {cf["url"].rsplit("/", 1)[-1].split("?")[0]}:{cf["lineNumber"]}'


def walk(i, d):
    if d > DEPTH:
        return
    n = nodes[i]
    kids = sorted(n.get("children", []), key=lambda c: -incl[c])
    big = [c for c in kids if incl[c] >= MIN]
    # collapse single-child chains
    print(f'{"  " * d}{incl[i]:7.0f} {name(n)}  (self {self_ms.get(i, 0):.0f})')
    for c in big:
        walk(c, d + 1)


walk(root, 0)
