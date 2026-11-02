/**
 * Named places along the current route (OSM villages, churches, towers…)
 * from the world bundle's manifest, for the ride HUD's next-landmark line.
 * Empty for routes outside a baked world or while the manifest loads.
 *
 * The manifest is the same small JSON file the world renderer reads first
 * (HTTP-cached); one fetch per world per session.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Route } from '@/types';
import { worldForRoute, worldUrl } from '@/lib/world/catalog';
import { validateManifest, type WorldManifest } from '@/lib/world/manifest';
import { routeLandmarks, type RouteLandmark } from '@/lib/world/routeLandmarks';
import { findClimbs } from '@/lib/climbDetection';
import { nextLandmarkText, type Landmark, type Units } from '@/components/velo/rideHudText';

const manifests = new Map<string, Promise<WorldManifest | null>>();

function loadManifest(url: string): Promise<WorldManifest | null> {
  let p = manifests.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j ? validateManifest(j) : null))
      .catch(() => null);
    manifests.set(url, p);
  }
  return p;
}

export function useRouteLandmarks(route: Route | null): RouteLandmark[] {
  const [state, setState] = useState<{ id: string; list: RouteLandmark[] } | null>(null);
  const entry = worldForRoute(route);

  useEffect(() => {
    if (!route || !entry) return;
    let live = true;
    void loadManifest(`${worldUrl(entry)}manifest.json`).then((m) => {
      if (!live || !m) return;
      setState({ id: route.id, list: routeLandmarks(route.points, m) });
    });
    return () => {
      live = false;
    };
  }, [route, entry]);

  return route && state?.id === route.id ? state.list : [];
}

/**
 * The ride HUD's next-landmark line ("Ponte Valleceppi in 1.2 km"): the next
 * named place the road passes (world POIs) or detected climb, whichever
 * comes first; null when nothing named is ahead.
 */
export function useNextLandmarkText(route: Route | null, distanceM: number, units: Units): string | null {
  const climbs = useMemo(() => (route && !route.isLive ? findClimbs(route) : []), [route]);
  const places = useRouteLandmarks(route);
  const landmarks = useMemo<Landmark[]>(
    () =>
      [
        ...climbs,
        ...places.map((p) => ({ name: p.name, startDistance: p.distance, endDistance: p.distance })),
      ].sort((a, b) => a.startDistance - b.startDistance),
    [climbs, places],
  );
  return nextLandmarkText(landmarks, distanceM, units);
}
