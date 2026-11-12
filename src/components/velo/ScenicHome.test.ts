/**
 * Home's destination sections render from the manifests
 * (src/lib/world/destinations/*.json), and ScenicHome.tsx holds no list of
 * places or routes of its own (P2.2: "Home is generated from manifests").
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import { SCENIC_ROUTES, todaysScenicRoute } from '@/lib/scenicRoutes';
import { DESTINATIONS, homeSections, validateDestination } from '@/lib/world/destinations';
import { ScenicHomeSections, homeSectionViews } from './ScenicHome';

// The public build (no VITE_HOUSEHOLD_LABELS), whatever a local env file says.
vi.stubEnv('VITE_HOUSEHOLD_LABELS', '');

const html = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ScenicHomeSections)));

describe('ScenicHomeSections', () => {
  const out = html();
  const today = todaysScenicRoute();

  it('shows Today’s ride named after its destination, then the three manifest sections in order', () => {
    expect(out).toContain('data-testid="featured-scenic-ride"');
    expect(out).toMatch(/Today’s ride · (Perugia)</);
    const titles = [...out.matchAll(/<h3 id="destination-[^"]+"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Perugia', 'Lugano', 'Places we want to go']);
    expect(out).toContain('data-destination-section="perugia"');
    expect(out).toContain('data-destination-section="lugano"');
    expect(out).toContain('data-destination-section="wishlist"');
  });

  it('offers every scenic route once (Today’s ride featured, the rest as tiles)', () => {
    const tiles = [...out.matchAll(/data-scenic-route="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(tiles).size).toBe(tiles.length);
    expect([...tiles, today.route.id].sort()).toEqual(SCENIC_ROUTES.map((r) => r.route.id).sort());
  });

  it('leads wishlist tiles with the place and keeps map-view honest per section', () => {
    expect(out).toMatch(/<h4[^>]*>Hangzhou<\/h4>/);
    expect(out).toContain('West Lake loop · Zhejiang, China');
    // Hometown mixes the Lugano world with map rides: those carry the badge.
    const hometown = out.slice(out.indexOf('data-destination-section="lugano"'), out.indexOf('data-destination-section="wishlist"'));
    expect(hometown.match(/Map view/g)).toHaveLength(4);
    expect(hometown).toMatch(/aria-label="Ride Lugano lakefront to Melide, [^"]*"/);
    expect(hometown).not.toMatch(/aria-label="Ride Lugano lakefront to Melide, [^"]*, map view"/);
    // The wishlist now mixes too: the places with a world lead (Chengdu,
    // Cleveland, the Cuyahoga Valley), the map rides carry the badge.
    const wishlist = out.slice(out.indexOf('data-destination-section="wishlist"'));
    const wishTiles = [...wishlist.matchAll(/data-scenic-route="([^"]+)"/g)].map((m) => m[1]);
    const worldTiles = [
      'scenic-chengdu-luxe-lakes',
      'scenic-chengdu-xinglong-lake',
      'scenic-cleveland-lakefront',
      'scenic-wendy-park-lakewood',
      'scenic-cuyahoga-towpath',
      'scenic-cuyahoga-towpath-north',
    ];
    expect(wishTiles.slice(0, worldTiles.length)).toEqual(worldTiles);
    expect(wishlist).toMatch(/aria-label="Ride Towpath: Lock 39 to Station Road in Cuyahoga Valley, [^"]*"/);
    expect(wishlist).not.toMatch(/aria-label="Ride Towpath: Lock 39 to Station Road in Cuyahoga Valley, [^"]*, map view"/);
    expect(wishlist).toMatch(/aria-label="Ride Luxe Lakes loop in Chengdu, [^"]*"/);
    expect(wishlist).toMatch(/aria-label="Ride Xinglong Lake loop in Chengdu, [^"]*"/);
    expect(wishlist).not.toMatch(/aria-label="Ride Luxe Lakes loop in Chengdu, [^"]*, map view"/);
    expect(wishlist).not.toMatch(/aria-label="Ride Xinglong Lake loop in Chengdu, [^"]*, map view"/);
    expect(wishlist).toMatch(/aria-label="Ride West Lake loop in Hangzhou, [^"]*, map view"/);
    expect(wishlist.match(/>Map view</g)).toHaveLength(wishTiles.length - worldTiles.length);
    expect(out).not.toContain('3D worlds coming; these ride on the map today');
  });
});

describe('homeSectionViews', () => {
  it('drops Today’s route and empty sections, and follows the manifests', () => {
    const views = homeSectionViews('scenic-perugia-tiber-park');
    expect(views[0].routes.map((r) => r.route.id)).toEqual(['scenic-assisi-valley', 'scenic-trasimeno-shore']);
    const one = validateDestination({
      ...JSON.parse(JSON.stringify(DESTINATIONS.find((d) => d.id === 'berkeley'))),
      format: 'velo-destination',
      version: 1,
    });
    // A section whose only route is today's disappears.
    expect(homeSectionViews('scenic-berkeley-bay-trail', homeSections([one]))).toEqual([]);
    expect(homeSectionViews(null, homeSections([one]))[0].placeById['scenic-berkeley-bay-trail']).toEqual({
      title: 'Berkeley',
      line: 'California, USA',
    });
  });
});

describe('architecture: Home is generated from destination manifests', () => {
  const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('ScenicHome.tsx and ScenicRoutes.tsx name no route, place or area list', () => {
    for (const file of ['./ScenicHome.tsx', './ScenicRoutes.tsx']) {
      const c = code(file);
      expect(c, file).not.toMatch(/['"`]scenic-[a-z]/);
      expect(c, file).not.toMatch(/SCENIC_AREAS|\.area\b/);
      for (const d of DESTINATIONS) expect(c, `${file} names ${d.name}`).not.toContain(`'${d.name}'`);
      expect(c, file).not.toMatch(/Places we want to go|Hometown|'Home'/);
    }
    expect(code('./ScenicHome.tsx')).toMatch(/homeSections\(\)/);
  });

  it('the world catalog is derived from the manifests, not listed', () => {
    const c = code('../../lib/world/catalog.ts');
    expect(c).toMatch(/worldCatalogFrom\(DESTINATIONS\)/);
    expect(c).not.toMatch(/south:\s*\d/);
    expect(c).not.toMatch(/'perugia'|'lugano'/);
  });
});
