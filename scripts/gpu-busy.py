"""Who is using the GPU right now: per-process DRM engine busy time from
/proc/<pid>/fdinfo (i915 / xe expose drm-engine-* and drm-cycles-*).
Usage: python3 scripts/gpu-busy.py [seconds=3]
"""
import collections, os, re, sys, time

SECS = float(sys.argv[1]) if len(sys.argv) > 1 else 3


def sample():
    out = collections.defaultdict(lambda: collections.Counter())
    names = {}
    for pid in filter(str.isdigit, os.listdir("/proc")):
        fd_dir = f"/proc/{pid}/fdinfo"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        seen = set()
        for fd in fds:
            try:
                txt = open(f"{fd_dir}/{fd}").read()
            except OSError:
                continue
            if "drm-client-id" not in txt:
                continue
            cid = re.search(r"drm-client-id:\s*(\d+)", txt).group(1)
            if cid in seen:
                continue
            seen.add(cid)
            for k, v in re.findall(r"(drm-(?:engine|cycles|total-cycles)-[\w-]+):\s*(\d+)", txt):
                out[pid][k] += int(v)
        if pid in out:
            try:
                names[pid] = open(f"/proc/{pid}/cmdline").read().replace("\0", " ")[:110]
            except OSError:
                names[pid] = "?"
    return out, names


a, names = sample()
t0 = time.time()
time.sleep(SECS)
b, names2 = sample()
dt = time.time() - t0
names.update(names2)
rows = []
for pid, cnt in b.items():
    prev = a.get(pid, collections.Counter())
    d = {k: v - prev.get(k, 0) for k, v in cnt.items()}
    # xe: drm-cycles-<class> / drm-total-cycles-<class>; i915: drm-engine-<class> in ns.
    busy = {}
    for k, v in d.items():
        if k.startswith("drm-engine-") and v > 0:
            busy[k[11:]] = round(100 * v / (dt * 1e9), 1)
        if k.startswith("drm-cycles-"):
            cls = k[11:]
            tot = d.get(f"drm-total-cycles-{cls}", 0)
            if tot > 0 and v > 0:
                busy[cls] = round(100 * v / tot, 1)
    if busy:
        rows.append((max(busy.values()), pid, busy))
for _, pid, busy in sorted(rows, reverse=True)[:12]:
    print(f"{pid:>8} {busy}  {names.get(pid, '?')}")
