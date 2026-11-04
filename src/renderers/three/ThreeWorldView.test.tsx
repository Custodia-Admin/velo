/**
 * The world scene hands the camera the route's landmarks (ThreeWorldView
 * WorldScene → ChaseCamera), so the show director can orbit the places the
 * ride passes. WorldScene is called as a plain function (useMemo/useEffect on
 * a stub runtime) and the elements it returns are read, not rendered.
 *
 * Review of PR #36 @bbe04db, I5: dropping ChaseCamera's `landmarks` prop left
 * every test green. The merge with #34 adds the drawn ground on the same
 * elements.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useMemo: <T,>(fn: () => T) => fn(),
    useEffect: () => undefined,
    useRef: <T,>(current: T) => ({ current }),
    useCallback: <T,>(fn: T) => fn,
    useState: <T,>(init: T | (() => T)) => [typeof init === 'function' ? (init as () => T)() : init, () => undefined] as const,
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});
// The landcover texture needs a DOM canvas; the scene's maps are not under test.
vi.mock('./landcoverTexture', () => ({ buildLandcoverCanvas: () => null }));

const { isValidElement } = await import('react');
const { WorldScene } = await import('./ThreeWorldView');
const { ChaseCamera } = await import('./ChaseCamera');
const { Ghosts } = await import('./Ghosts');
const { PaceBots } = await import('./Rider');
const { sceneLandmarks } = await import('./directorCamera');
const { THREE_QUALITY } = await import('./quality');
const { syntheticSceneWorld } = await import('./syntheticWorld');
const { createProjection } = await import('@/lib/world/projection');

type El = ReactElement<Record<string, unknown>>;
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (isValidElement(node)) {
    out.push(node as El);
    for (const v of Object.values((node as El).props)) elements(v, out);
  }
  return out;
}

describe('WorldScene', () => {
  it("gives the chase camera the route's landmarks (the director's orbits)", () => {
    const params = { type: 'tmerc', ellipsoid: 'WGS84', lat0: 43.1107, lon0: 12.3908, k0: 1 } as const;
    const proj = createProjection(params);
    const sw = syntheticSceneWorld();
    Object.assign(sw.world.manifest as object, {
      projection: params,
      pois: [{ name: 'Rivotorto', kind: 'village', x: 0, y: 60, h: 0, osm: 'node/1' }],
    });
    const points = Array.from({ length: 61 }, (_, i) => {
      const [lat, lon] = proj.inverse(-300 + i * 10, 0);
      return { lat, lon, ele: 0, distance: i * 10 };
    });
    const route = { id: 'synthetic-line', name: 'Line', points, totalDistance: 600 } as never;

    const tree = WorldScene({
      sceneWorld: sw,
      route,
      quality: { ...THREE_QUALITY.medium, occlusionScale: 0 },
      tier: 'medium',
      lightInput: { mood: 'clear-afternoon', lat: 43.11, lon: 12.39 } as never,
      override: { current: null },
      onReady: () => undefined,
      onDpr: () => undefined,
    });
    const cams = elements(tree).filter((e) => e.type === ChaseCamera);
    expect(cams).toHaveLength(1);
    const expected = sceneLandmarks(route, sw);
    expect(expected.map((l) => l.name)).toEqual(['Rivotorto']);
    expect(cams[0].props.landmarks).toEqual(expected);

    // ...and the drawn ground (PR #34): the camera, the ghosts and the pace bots stand on the same surface.
    const ground = cams[0].props.ground;
    expect(typeof ground).toBe('function');
    const ghosts = elements(tree).filter((e) => e.type === Ghosts);
    const bots = elements(tree).filter((e) => e.type === PaceBots);
    expect(ghosts).toHaveLength(1);
    expect(bots).toHaveLength(1);
    expect(ghosts[0].props.ground).toBe(ground);
    expect(bots[0].props.ground).toBe(ground);
  });
});
