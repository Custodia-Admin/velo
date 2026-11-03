import json, collections, sys
prof = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'render-profile.cpuprofile'))
nodes = {n['id']: n for n in prof['nodes']}
parent = {}
for n in prof['nodes']:
    for c in n.get('children', []):
        parent[c] = n['id']
byfile = collections.Counter(); bytop = collections.Counter(); total = 0
for sid, dt in zip(prof['samples'], prof['timeDeltas']):
    total += dt
    files = set(); chain = []; i = sid
    while i is not None:
        cf = nodes[i]['callFrame']; f = cf['url'].split('/')[-1] or cf['functionName']
        files.add(f.split('-')[0]); chain.append(i); i = parent.get(i)
    for f in files: byfile[f] += dt
    # second frame from root = top-level task
    top = chain[-2] if len(chain) >= 2 else chain[-1]
    cf = nodes[top]['callFrame']; bytop[f"{cf['functionName'] or '(anon)'}@{cf['url'].split('/')[-1]}:{cf['lineNumber']}"] += dt
print('inclusive by file (ms, %):')
for k, v in byfile.most_common(15): print(f'  {v/1000:7.0f} {100*v/total:5.1f}%  {k}')
print('top-level tasks:')
for k, v in bytop.most_common(12): print(f'  {v/1000:7.0f} {100*v/total:5.1f}%  {k}')
