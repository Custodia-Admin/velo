"""Find and ride a scenic route from Home, whichever way Home shows it today.

Home's "Today's ride" (todaysScenicRoute, rotates daily over the near-home
routes) renders as [data-testid=featured-scenic-ride] and is dropped from the
[data-scenic-route] grid. A script that waits only on the grid card times out
on the day its route is featured. These helpers accept either: the grid card,
or the featured card's exact "Ride <name>" button (not "Ride and watch").
Same rule as rideScenicRoute in e2e/smoke-ride.spec.ts.

Import from a script in scripts/ (its own dir is on sys.path):

    from scenic_home import ride_scenic_route
    ride_scenic_route(page, "scenic-perugia-tiber-park")   # -> "grid" | "featured"
    page.wait_for_url("**/ride**")
"""
import functools
import pathlib
import re
import sys

SCENIC_TS = pathlib.Path(__file__).resolve().parent.parent / "src" / "lib" / "scenicRoutes.ts"

# Returns "grid", "featured" or null. Clicks the match when asked to.
_FIND = """([id, name, click]) => {
  const grid = document.querySelector(`[data-scenic-route="${CSS.escape(id)}"]`);
  const box = document.querySelector('[data-testid="featured-scenic-ride"]');
  const featured = box && [...box.querySelectorAll('button')]
    .find((b) => b.getAttribute('aria-label') === `Ride ${name}`);
  const el = grid || featured;
  if (!el) return null;
  if (click) el.click();
  return grid ? 'grid' : 'featured';
}"""


@functools.lru_cache(maxsize=None)
def scenic_route_names() -> dict:
    """id -> display name, read from the app's scenic route metadata."""
    src = SCENIC_TS.read_text(encoding="utf-8")
    pairs = re.findall(r"id:\s*'([^']+)',\s*name:\s*'((?:[^'\\]|\\.)*)'", src)
    return {i: re.sub(r"\\(.)", r"\1", n) for i, n in pairs}


def scenic_route_name(route_id: str) -> str:
    names = scenic_route_names()
    if route_id not in names:
        raise KeyError(f"unknown scenic route {route_id!r} (not in {SCENIC_TS})")
    return names[route_id]


def wait_scenic_route(page, route_id: str, timeout: int = 30000) -> str:
    """Wait until Home shows the route as a grid card or as Today's ride."""
    name = scenic_route_name(route_id)
    handle = page.wait_for_function(f"(a) => ({_FIND})([a[0], a[1], false])",
                                    arg=[route_id, name], timeout=timeout)
    return handle.json_value()


def ride_scenic_route(page, route_id: str, timeout: int = 30000) -> str:
    """Click the route's grid card or the featured "Ride <name>" button.

    Uses el.click() (a user gesture, no pointer stability wait). Returns which
    one was clicked; callers still wait for /ride themselves.
    """
    wait_scenic_route(page, route_id, timeout)
    which = page.evaluate(f"(a) => ({_FIND})([a[0], a[1], true])", [route_id, scenic_route_name(route_id)])
    if which is None:
        raise RuntimeError(f"scenic route {route_id!r} vanished from Home before the click")
    print(f"scenic route {route_id}: clicked the {which} card", file=sys.stderr)
    return which
