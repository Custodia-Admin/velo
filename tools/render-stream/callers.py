import json, collections, sys
prof = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'render-profile.cpuprofile'))
target = sys.argv[2] if len(sys.argv) > 2 else 'readPixels'
nodes = {n['id']: n for n in prof['nodes']}
parent = {}
for n in prof['nodes']:
    for c in n.get('children', []):
        parent[c] = n['id']
cnt = collections.Counter()
for sid, dt in zip(prof['samples'], prof['timeDeltas']):
    if nodes[sid]['callFrame']['functionName'] != target:
        continue
    chain = []; i = parent.get(sid)
    while i is not None and len(chain) < 14:
        cf = nodes[i]['callFrame']; chain.append(f"{cf['functionName'] or '(anon)'}@{cf['url'].split('/')[-1]}:{cf['lineNumber']}"); i = parent.get(i)
    cnt[' < '.join(chain)] += dt
for k, v in cnt.most_common(4):
    print(f'{v/1000:.0f} ms: {k}\n')
