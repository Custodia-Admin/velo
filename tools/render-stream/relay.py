#!/usr/bin/env python3
"""Velo render-streaming spike: state relay between ride clients and render pages.

Runs on cat-bed (system python3 + aiohttp), bound to 127.0.0.1; exposed on the
tailnet only via `tailscale serve --bg --https=8444 http://127.0.0.1:8095`.

  GET /ws?role=client|render&room=<id>   JSON messages, relayed to the other role in the room
  GET /health?room=<id>                  {"ok", "render": n, "clients": n}
  GET /                                  static files from ./www (test pages)

Message shapes (spike protocol, see docs/architecture/STREAMING-SPIKE.md):
  client -> render  {"t":"state", "seq", "sentAt", ...ride state}
  client -> relay   {"t":"ping", "c0"}            relay answers {"t":"pong", "c0", "s"} (clock offset)
  render -> client  {"t":"applied", "seq", "s"}    render page applied a state (server epoch ms)
  client -> relay   {"t":"report", "ua", "screen", "s"} measurement summary, appended to reports.jsonl
"""
import asyncio, json, os, sys, time
from collections import defaultdict
from aiohttp import web, WSMsgType

ROOMS = defaultdict(lambda: {"client": set(), "render": set()})
WWW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")


async def ws_handler(request):
    role = request.query.get("role", "client")
    room = request.query.get("room", "default")
    if role not in ("client", "render"):
        raise web.HTTPBadRequest(text="role must be client or render")
    ws = web.WebSocketResponse(heartbeat=10, compress=False)
    await ws.prepare(request)
    peers = ROOMS[room]
    peers[role].add(ws)
    other = "render" if role == "client" else "client"
    print(f"[relay] +{role} room={room} clients={len(peers['client'])} renders={len(peers['render'])}", flush=True)
    for w in list(peers[other]):  # presence, so a client can fall back when no renderer is up
        await _send(w, {"t": "presence", "role": role, "up": True, "n": len(peers[role])})
    await ws.send_str(json.dumps({"t": "presence", "role": other, "up": bool(peers[other]), "n": len(peers[other])}))
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            data = msg.data
            if role == "client":
                try:
                    m = json.loads(data)
                except ValueError:
                    continue
                if m.get("t") == "report":
                    m["room"] = room; m["at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                    with open(os.path.join(os.path.dirname(WWW), "reports.jsonl"), "a") as f:
                        f.write(json.dumps(m) + "\n")
                    continue
                if m.get("t") == "ping":
                    await ws.send_str(json.dumps({"t": "pong", "c0": m.get("c0"), "s": time.time() * 1000}))
                    continue
            for w in list(peers[other]):
                await _send(w, data)
    finally:
        peers[role].discard(ws)
        print(f"[relay] -{role} room={room}", flush=True)
        for w in list(peers[other]):
            await _send(w, {"t": "presence", "role": role, "up": bool(peers[role]), "n": len(peers[role])})
    return ws


async def _send(ws, data):
    try:
        await ws.send_str(data if isinstance(data, str) else json.dumps(data))
    except Exception:
        pass


async def health(request):
    """Liveness for clients deciding between remote and local render."""
    room = request.query.get("room", "default")
    peers = ROOMS.get(room, {"client": set(), "render": set()})
    return web.json_response({"ok": True, "render": len(peers["render"]), "clients": len(peers["client"])})


async def index(request):
    raise web.HTTPFound("/client.html")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8095
    app = web.Application()
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/health", health)
    app.router.add_get("/", index)
    app.router.add_static("/", WWW, show_index=False)
    web.run_app(app, host="127.0.0.1", port=port, print=lambda *_: print(f"[relay] 127.0.0.1:{port}", flush=True))


if __name__ == "__main__":
    main()
