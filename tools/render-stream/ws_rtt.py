# WS RTT to the relay (no video): laptop -> tailscale serve -> relay. Usage: ws_rtt.py [n] [url]
import asyncio, json, sys, time, statistics
import aiohttp
N = int(sys.argv[1]) if len(sys.argv) > 1 else 100
URL = sys.argv[2] if len(sys.argv) > 2 else 'wss://cat-bed.tail6f8715.ts.net:8443/velo-relay/ws?role=client&room=rtt'
async def main():
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(URL) as ws:
            await ws.receive()  # presence
            rtts = []
            for i in range(N):
                t0 = time.perf_counter() * 1000
                await ws.send_str(json.dumps({'t': 'ping', 'c0': t0}))
                while True:
                    m = json.loads((await ws.receive()).data)
                    if m.get('t') == 'pong': break
                rtts.append(time.perf_counter() * 1000 - t0)
                await asyncio.sleep(0.05)
            rtts.sort()
            print(f'n={N} min={rtts[0]:.1f} p50={rtts[N//2]:.1f} p95={rtts[int(N*.95)]:.1f} max={rtts[-1]:.1f} ms')
asyncio.run(main())
