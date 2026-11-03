#!/usr/bin/env python3
"""Mutation checks for the device layer's write gates (P2.5).

Each entry removes one guard (no autonomous BLE write outside the ride
session, one advert watch per device, honest wake state, gear-buzz gate,
id-only device lookup, battery band, the ride-start reconnects of both
devices, the trainer-lost toast's Reconnect) and runs the tests that should
catch it. An entry may remove several guards at once (M0, M20, M28) or edit
a second file. Every mutation must make a test fail ("KILLED"). Sources are
restored after each run. Usage, from the repo root:

    python3 scripts/device-gate-mutations.py            # all
    python3 scripts/device-gate-mutations.py M1 M8      # some
"""
import shutil, subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

M = [
    ('M0 ftms: every ride-session gate removed (drop, loop attempt, handshake)', 'src/lib/ftms.ts',
     [('  if (!rideSessionActive()) {\n    holdForTap(device);', '  if (false) {\n    holdForTap(device);'),
      ('        if (!rideSessionActive()) throw new RideClosedError();\n', ''),
      ('await setupGattSession(dev, rideSessionActive);', 'await setupGattSession(dev);')],
     None,
     ['src/lib/deviceLayer.test.ts']),
    ('M1 ftms: no-ride drop gate removed', 'src/lib/ftms.ts',
     '  if (!rideSessionActive()) {\n    holdForTap(device);', '  if (false) {\n    holdForTap(device);',
     ['src/lib/deviceLayer.test.ts']),
    ('M2 ftms: loop attempt session check removed', 'src/lib/ftms.ts',
     '        if (!rideSessionActive()) throw new RideClosedError();\n', '',
     ['src/lib/deviceLayer.test.ts']),
    ('M3 ftms: handshake allowWrites dropped in loop', 'src/lib/ftms.ts',
     'await setupGattSession(dev, rideSessionActive);', 'await setupGattSession(dev);',
     ['src/lib/deviceLayer.test.ts']),
    ('M4 ftms: mayWrite before handshake removed', 'src/lib/ftms.ts',
     '  // RESULT_CONTROL_NOT_PERMITTED back, which writeControl will surface.\n  mayWrite();\n',
     '  // RESULT_CONTROL_NOT_PERMITTED back, which writeControl will surface.\n',
     ['src/lib/deviceLayer.test.ts']),
    ('M5 controls: no-ride drop gate removed', 'src/lib/controllers/rideController.ts',
     '  if (!rideSessionActive()) {\n    goAsleep(l);\n    return;\n  }\n  void retryLink(l);', '  void retryLink(l);',
     ['src/lib/controllers/rideController.test.ts']),
    ('M6 controls: retry session check removed', 'src/lib/controllers/rideController.ts',
     'attempt: () => (rideSessionActive() ? setupSession(l, rideSessionActive) : Promise.reject(rideClosedError())),',
     'attempt: () => setupSession(l, rideSessionActive),',
     ['src/lib/controllers/rideController.test.ts']),
    ('M7 controls: RideOn allowWrites check removed', 'src/lib/controllers/rideController.ts',
     '  if (allowWrites && !allowWrites()) {\n    l.rx = null;\n    throw rideClosedError();\n  }\n', '',
     ['src/lib/controllers/rideController.test.ts']),
    ('M8 gear buzz: ride-session gate removed', 'src/lib/controllers/rideController.ts',
     "if (!store().gearBuzz || !rideSessionActive()) return false;", "if (!store().gearBuzz) return false;",
     ['src/lib/controllers/rideController.test.ts']),
    ('M9 watchAdverts: no sharing (one browser watch per caller)', 'src/lib/controllers/reconnect.ts',
     'const shared = sharedWatches.get(device) ?? openSharedWatch(device, d);', 'const shared = openSharedWatch(device, d);',
     ['src/lib/deviceLayer.test.ts', 'src/lib/controllers/reconnect.test.ts']),
    ('M10 trainer wake: not disarmed on connect', 'src/lib/trainerReconnect.ts',
     "  if (s.connection === 'connected' && prev.connection !== 'connected') disarmWake();", '',
     ['src/lib/deviceLayer.test.ts']),
    ('M11 trainer wake: refused watch reported armed', 'src/lib/trainerReconnect.ts',
     '  if (!ok && wake === w) wake = null;\n  return ok && wake === w;', '  return true;',
     ['src/lib/deviceLayer.test.ts']),
    ('M12 controls wake: refused watch reported armed', 'src/lib/controllers/rideController.ts',
     'const armed = ok && l.wake === w;', 'const armed = true;',
     ['src/lib/controllers/rideController.test.ts']),
    ('M13 controls wake: not disarmed on reconnect', 'src/lib/controllers/rideController.ts',
     '  l.silentTimer = null;\n  disarmWake(l);\n}', '  l.silentTimer = null;\n}',
     ['src/lib/controllers/rideController.test.ts']),
    ('M14 granted lookup: name fallback back', 'src/lib/controllers/reconnect.ts',
     'return devices.find((d) => d.id === last.id) ?? null;',
     'return devices.find((d) => d.id === last.id) ?? (last.name ? devices.find((d) => d.name === last.name) : undefined) ?? null;',
     ['src/lib/controllers/reconnect.test.ts']),
    ('M15 trainer silent reconnect: session check removed', 'src/lib/trainerReconnect.ts',
     '  if (opts.silent && !rideSessionActive()) return false;\n', '',
     ['src/lib/trainerReconnect.test.ts']),
    ('M16 battery: 76 % full again', 'src/lib/controllers/battery.ts',
     'export const MEDIUM_BATTERY_MAX_PCT = 80;', 'export const MEDIUM_BATTERY_MAX_PCT = 70;',
     ['src/lib/controllers/battery.test.ts']),
    ('M17 controls ride-start reconnect: session check removed', 'src/lib/controllers/rideController.ts',
     '  if (silent && !rideSessionActive()) return false;\n', '',
     ['src/lib/controllers/rideController.test.ts']),
    ('M18 controls ride-start reconnect: RideOn allowWrites not passed', 'src/lib/controllers/rideController.ts',
     'await setupSession(l, allowWrites);', 'await setupSession(l);',
     ['src/lib/controllers/rideController.test.ts']),
    ('M19 controls ride-start reconnect: confirm-buzz session check removed', 'src/lib/controllers/rideController.ts',
     'if (!allowWrites || allowWrites()) await confirmBuzz(l);', 'await confirmBuzz(l);',
     ['src/lib/controllers/rideController.test.ts']),
    ('M20 controls ride-start reconnect: every gate removed (the round-2 D1 code)', 'src/lib/controllers/rideController.ts',
     [('  if (silent && !rideSessionActive()) return false;\n', ''),
      ('await setupSession(l, allowWrites);', 'await setupSession(l);'),
      ('if (!allowWrites || allowWrites()) await confirmBuzz(l);', 'await confirmBuzz(l);')],
     None,
     ['src/lib/controllers/rideController.test.ts']),
    ('M21 Ride page: controls ride-start reconnect not silent', 'src/routes/Ride.tsx',
     'reconnectGrantedController({ silent: true });', 'reconnectGrantedController();',
     ['src/lib/controllers/rideController.test.ts']),
    ('M22 trainer-lost toast: no Reconnect action', 'src/components/trainer/TrainerEventBridge.tsx',
     "    action: {\n      label: 'Reconnect',", "    action: undefined && {\n      label: 'Reconnect',",
     ['src/lib/deviceLayer.test.ts']),
    ('M23 trainer-lost toast: a failed tap does not offer Reconnect again', 'src/components/trainer/TrainerEventBridge.tsx',
     "            pushTrainerLostToast('Still no trainer.", "            if (Math.random() > 2) pushTrainerLostToast('Still no trainer.",
     ['src/lib/deviceLayer.test.ts']),
    ('M24 trainer-lost toast: not sticky without a wake watch', 'src/components/trainer/TrainerEventBridge.tsx',
     'wakes ? 10_000 : null,', '10_000,',
     ['src/lib/deviceLayer.test.ts']),
    ('M25 trainer reconnected toast: does not replace the sticky one', 'src/lib/trainerReconnect.ts',
     "st.pushToast({ id: 'trainer-connection', kind: 'success',", "st.pushToast({ kind: 'success',",
     ['src/lib/deviceLayer.test.ts']),
    ('M26 trainer ride-start reconnect: allowWrites not passed', 'src/lib/trainerReconnect.ts',
     'opts.silent ? { allowWrites: rideSessionActive } : {}', '{}',
     ['src/lib/deviceLayer.test.ts', 'src/lib/trainerReconnect.test.ts']),
    ('M27 ftms reconnectGranted: post-advert ride check removed', 'src/lib/ftms.ts',
     '      if (opts.allowWrites && !opts.allowWrites()) throw new RideClosedError();\n', '',
     ['src/lib/deviceLayer.test.ts', 'src/lib/trainerReconnect.test.ts']),
    ('M28 trainer ride-start reconnect: both checks removed (the round-2 T1 gap)', 'src/lib/trainerReconnect.ts',
     [('opts.silent ? { allowWrites: rideSessionActive } : {}', '{}')],
     None,
     ['src/lib/deviceLayer.test.ts', 'src/lib/trainerReconnect.test.ts'],
     ('src/lib/ftms.ts', [('      if (opts.allowWrites && !opts.allowWrites()) throw new RideClosedError();\n', '')])),
    ('M29 Ride page: trainer ride-start reconnect not silent', 'src/routes/Ride.tsx',
     'reconnectGrantedTrainer({ silent: true });', 'reconnectGrantedTrainer();',
     ['src/lib/controllers/rideController.test.ts']),
]

only = set(sys.argv[1:])
bad = []
for name, path, old, new, tests, *extra in M:
    if only and name.split()[0] not in only:
        continue
    # One entry may edit a second file too: (path, [(old, new), ...]).
    edits = [(path, old if isinstance(old, list) else [(old, new)]), *extra]
    plan, missing = [], None
    for fpath, pairs in edits:
        src = open(fpath).read()
        missing = next((o for o, _ in pairs if src.count(o) != 1), None)
        if missing:
            break
        mutated = src
        for o, n in pairs:
            mutated = mutated.replace(o, n)
        plan.append((fpath, mutated))
    if missing:
        print(f'!! {name}: pattern not unique/found: {missing[:60]!r}')
        bad.append(name)
        continue
    for fpath, _ in plan:
        shutil.copy(fpath, fpath + '.bak')
    try:
        for fpath, mutated in plan:
            open(fpath, 'w').write(mutated)
        r = subprocess.run(['npx', 'vitest', 'run', *tests], capture_output=True, text=True)
        out = r.stdout + r.stderr
        failed = [ln.strip() for ln in out.splitlines() if ln.strip().startswith('×')]
        verdict = 'KILLED' if r.returncode != 0 else 'SURVIVED'
        print(f'{verdict}  {name}')
        for f in failed[:8]:
            print('     ', f)
        if r.returncode == 0:
            bad.append(name)
    finally:
        for fpath, _ in plan:
            shutil.move(fpath + '.bak', fpath)

print('ALL KILLED' if not bad else f'SURVIVORS: {bad}')
sys.exit(1 if bad else 0)
