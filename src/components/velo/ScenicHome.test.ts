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
import { worldForRoute } from '@/lib/world/catalog';
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

  it('features a route a baked world draws, with no Classic view tag', () => {
    expect(worldForRoute(today.route)).not.toBeNull();
    const featured = out.slice(out.indexOf('data-testid="featured-scenic-ride"'), out.indexOf('data-destination-section='));
    expect(featured).not.toContain('Classic view');
  });

  it('leads wishlist tiles with the place and tags exactly the classic-view routes', () => {
    expect(out).toMatch(/<h4[^>]*>Hangzhou<\/h4>/);
    expect(out).toContain('West Lake loop · Zhejiang, China');
    // Home and Hometown ride in baked worlds only (Lugano's outlying routes in
    // its extra worlds, Trasimeno in Perugia's): no tile there carries the tag.
    const home = out.slice(out.indexOf('data-destination-section="perugia"'), out.indexOf('data-destination-section="lugano"'));
    const hometown = out.slice(out.indexOf('data-destination-section="lugano"'), out.indexOf('data-destination-section="wishlist"'));
    expect(hometown.match(/data-scenic-route="/g)?.length).toBeGreaterThanOrEqual(5);
    expect(home).not.toContain('Classic view');
    expect(hometown).not.toContain('Classic view');
    expect(hometown).toMatch(/aria-label="Ride Valle Maggia[^"]*"/);
    expect(hometown).not.toMatch(/, classic view"/);
    // The wishlist mixes too: the places with a world lead (Chengdu,
    // Cleveland, the Cuyahoga Valley, then the coast worlds), the classic-view
    // rides carry the tag.
    const wishlist = out.slice(out.indexOf('data-destination-section="wishlist"'));
    const wishTiles = [...wishlist.matchAll(/data-scenic-route="([^"]+)"/g)].map((m) => m[1]);
    const worldTiles = [
      'scenic-chengdu-luxe-lakes',
      'scenic-chengdu-xinglong-lake',
      'scenic-cleveland-lakefront',
      'scenic-wendy-park-lakewood',
      'scenic-cuyahoga-towpath',
      'scenic-cuyahoga-towpath-north',
      'scenic-berkeley-bay-trail',
      'scenic-richmond-marina-bay',
      'scenic-santa-monica-strand',
      'scenic-will-rogers-venice',
      'scenic-puerto-vallarta-malecon',
      'scenic-nuevo-vallarta-bucerias',
    ];
    expect(wishTiles.slice(0, worldTiles.length)).toEqual(worldTiles);
    expect(wishlist).toMatch(/aria-label="Ride Towpath: Lock 39 to Station Road in Cuyahoga Valley, [^"]*"/);
    expect(wishlist).not.toMatch(/aria-label="Ride Towpath: Lock 39 to Station Road in Cuyahoga Valley, [^"]*, classic view"/);
    expect(wishlist).toMatch(/aria-label="Ride Will Rogers to Venice in Santa Monica, [^"]*"/);
    expect(wishlist).not.toMatch(/aria-label="Ride (Berkeley shoreline|Richmond Marina Bay|Santa Monica to Hermosa Beach|Will Rogers to Venice|Puerto Vallarta bayfront|Nuevo Vallarta to Bucerías) in [^"]*, classic view"/);
    expect(wishlist).toMatch(/aria-label="Ride Luxe Lakes loop in Chengdu, [^"]*"/);
    expect(wishlist).toMatch(/aria-label="Ride Xinglong Lake loop in Chengdu, [^"]*"/);
    expect(wishlist).not.toMatch(/aria-label="Ride Luxe Lakes loop in Chengdu, [^"]*, classic view"/);
    expect(wishlist).not.toMatch(/aria-label="Ride Xinglong Lake loop in Chengdu, [^"]*, classic view"/);
    expect(wishlist).toMatch(/aria-label="Ride West Lake loop in Hangzhou, [^"]*, classic view"/);
    expect(wishlist.match(/>Classic view</g)).toHaveLength(wishTiles.length - worldTiles.length);
    expect(out).not.toContain('Map view');
    expect(out).not.toContain('3D worlds coming');
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
      routes: ['scenic-berkeley-bay-trail'],
      world: null,
    });
    // A section whose only route is today's disappears.
    expect(homeSectionViews('scenic-berkeley-bay-trail', homeSections([one]))).toEqual([]);
    expect(homeSectionViews(null, homeSections([one]))[0].placeById['scenic-berkeley-bay-trail']).toEqual({
      title: 'Berkeley',
      line: 'California, USA',
    });
    // With its second ride, each card names its route.
    const wish = homeSectionViews(null).find((v) => v.id === 'wishlist')!;
    expect(wish.placeById['scenic-berkeley-bay-trail'].line).toBe('Berkeley shoreline · California, USA');
    expect(wish.placeById['scenic-richmond-marina-bay'].line).toBe('Richmond Marina Bay · California, USA');
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
