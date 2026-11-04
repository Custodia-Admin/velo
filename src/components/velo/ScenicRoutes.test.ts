/**
 * v2 Home surfaces (docs/design/mockups/v2-home.html): Today's ride, the area
 * tiles, the comfort line and the Home header. Static markup only (node env):
 * the hooks the e2e smoke spec and the shot scripts rely on, plate vs map
 * plate per route, and the comfort panel closed by default.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SCENIC_ROUTES, scenicRouteById } from '@/lib/scenicRoutes';
import { FeaturedScenicRide, ScenicRouteGrid, ScenicRouteGridSkeleton } from './ScenicRoutes';
import { ComfortControls, RiderRename, RiderSwitch } from './RiderPanel';
import { HomeHeader, devicesButtonText } from './HomeHeader';

const tiber = scenicRouteById('scenic-perugia-tiber-park')!;
const assisi = scenicRouteById('scenic-assisi-valley')!;
const trasimeno = scenicRouteById('scenic-trasimeno-shore')!;
const noop = () => {};

function html(el: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, el));
}

describe('FeaturedScenicRide (Today’s ride)', () => {
  const out = html(createElement(FeaturedScenicRide, { info: tiber, onRide: noop, onRideWithShow: noop, place: 'Perugia' }));

  it('keeps the hooks the smoke spec clicks', () => {
    expect(out).toContain('data-testid="featured-scenic-ride"');
    expect(out).toContain(`aria-label="Ride ${tiber.name}"`);
    expect(out).toContain('data-testid="ride-and-watch"');
  });

  it('leads with the world still (day + night plates) and names the place', () => {
    expect(out).toContain('posters/');
    expect(out).toContain('home-hero-tiber.jpg');
    expect(out).toContain('home-hero-tiber-night.jpg');
    expect(out).toContain('Today’s ride · Perugia');
    expect(html(createElement(FeaturedScenicRide, { info: tiber, onRide: noop }))).toContain('Today’s ride</span>');
    expect(out).toMatch(/10\.\d km · flat · about \d+ min/);
  });

  it('uses the flat primary button, no glow', () => {
    expect(out).not.toContain('shadow-glow');
    expect(out).toContain('bg-primary');
  });

  it('falls back to a map plate when the route has no world still', () => {
    const map = html(createElement(FeaturedScenicRide, { info: trasimeno, onRide: noop }));
    expect(map).not.toContain('<img');
    expect(map).toContain('<polyline');
    expect(map).not.toContain('ride-and-watch');
  });
});

describe('ScenicRouteGrid (area tiles)', () => {
  const out = html(
    createElement(ScenicRouteGrid, { routes: [assisi, trasimeno], activeRouteId: assisi.route.id, onRide: noop }),
  );

  it('renders one button per route with the data hook and pressed state', () => {
    expect(out.match(/data-scenic-route="/g)).toHaveLength(2);
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('ring-primary');
  });

  it('marks routes without a baked world as map view', () => {
    expect(out).toContain('home-assisi.jpg');
    expect(out.match(/Map view/g)).toHaveLength(1);
    expect(out).toContain('3D world coming; rides on the map today');
    expect(out).toMatch(/aria-label="Ride Lake Trasimeno shore, [^"]*, map view"/);
  });

  it('does not repeat the Map view badge in an area where every route is a map ride', () => {
    const travels = SCENIC_ROUTES.filter((r) => r.area === 'travels');
    const all = html(createElement(ScenicRouteGrid, { routes: travels, onRide: noop }));
    expect(all.match(/data-scenic-route="/g)).toHaveLength(travels.length);
    expect(all).not.toContain('Map view');
    expect(all).not.toContain('3D world coming');
    // Screen readers still hear it on every map tile.
    expect(all.match(/, map view"/g)).toHaveLength(travels.length);
  });

  it('leads a tile with its place when given one (the wishlist), keeping the route in the label', () => {
    const west = scenicRouteById('scenic-hangzhou-west-lake')!;
    const out2 = html(
      createElement(ScenicRouteGrid, {
        routes: [west],
        onRide: noop,
        placeById: { [west.route.id]: { title: 'Hangzhou', line: 'West Lake loop · Zhejiang, China' } },
      }),
    );
    expect(out2).toMatch(/<h4[^>]*>Hangzhou<\/h4>/);
    expect(out2).toContain('West Lake loop · Zhejiang, China');
    expect(out2).toMatch(/aria-label="Ride West Lake loop in Hangzhou, [^"]*, map view"/);
    expect(out2).toContain('data-scenic-route="scenic-hangzhou-west-lake"');
  });

  it('uses two columns at lg for two or four routes, else three', () => {
    expect(out).not.toContain('lg:grid-cols-3');
    const three = html(createElement(ScenicRouteGrid, { routes: SCENIC_ROUTES.slice(0, 3), onRide: noop }));
    expect(three).toContain('lg:grid-cols-3');
  });

  it('skeleton has the plate shape', () => {
    expect(renderToStaticMarkup(createElement(ScenicRouteGridSkeleton))).toContain('aspect-3/2');
  });
});

describe('Comfort line and rider switch', () => {
  it('summarises the feel and keeps the controls closed until Change', () => {
    const out = html(createElement(ComfortControls));
    expect(out).toMatch(/Hills feel <b[^>]*>\d+ %<\/b>/);
    expect(out).toContain('Wind feel');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('role="switch"');
    expect(out).not.toContain('type="range"');
  });

  it('rider pills are a radiogroup with no rename pencil on Home (as mocked)', () => {
    const out = html(createElement(RiderSwitch));
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('aria-label="Who&#x27;s riding"');
    expect(out).not.toContain('aria-label="Rename ');
    expect(html(createElement(RiderSwitch, { renamable: true }))).toContain('aria-label="Rename ');
  });

  it('Settings > Rider offers the rename', () => {
    expect(html(createElement(RiderRename))).toContain('aria-label="Rename ');
  });
});

describe('HomeHeader', () => {
  it('shows Devices with an idle dot when no trainer is connected', () => {
    const out = html(createElement(HomeHeader));
    expect(out).toContain('aria-label="Devices: no trainer paired"');
    expect(out).toContain('bg-muted-foreground');
    expect(out).not.toContain('Switch to');
    expect(out).toContain('aria-label="Open settings"');
  });

  it('names the connected trainer by model, with the dot on', () => {
    expect(devicesButtonText(true, 'KICKR CORE 78C1')).toEqual({
      label: 'KICKR CORE',
      ariaLabel: 'Devices: KICKR CORE 78C1 connected',
      on: true,
    });
    expect(devicesButtonText(true, null).label).toBe('Trainer');
  });

  it('names a trainer paired earlier, dot off, and says Devices when none is known', () => {
    expect(devicesButtonText(false, null, 'KICKR CORE 78C1')).toEqual({
      label: 'KICKR CORE',
      ariaLabel: 'Devices: KICKR CORE 78C1 paired, not connected',
      on: false,
    });
    expect(devicesButtonText(false, 'KICKR CORE 78C1')).toEqual({
      label: 'Devices',
      ariaLabel: 'Devices: no trainer paired',
      on: false,
    });
  });
});
