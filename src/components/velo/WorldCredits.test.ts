import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { DESTINATIONS, validateDestination, type Destination } from '@/lib/world/destinations';
import type { WorldCredit } from '@/lib/world/manifest';
import { GLO30_CREDIT, GLO30_DISCLAIMER } from '../../../tools/worldbake/fetchGlo30.mjs';
import { GLO30_DEM_SOURCE } from '../../../tools/worldbake/demSource.mjs';
import { creditsFor } from '../../../tools/worldbake/bake.mjs';
import { destinationFromWorld } from '../../../tools/worldbake/syncDestinations.mjs';
import { WorldCredits } from './WorldCredits';
import { creditPlaces, worldCredits } from './worldCredits';

/**
 * "Map & terrain credits" on Home. The Copernicus GLO-30 licence (Art. 6)
 * makes whoever shows the data to the public carry its notice (6(b)) and its
 * liability sentence (6(c)); both travel in the bundle's manifest credits.
 * These tests pin that the disclosure renders every credit field from the
 * destinations it is given, not from copy of its own, and that Home (not
 * the ride) mounts it.
 */

const ROOT = resolve(__dirname, '../../..');
const DEST_DIR = fileURLToPath(new URL('../../lib/world/destinations/', import.meta.url));
const WORLDS = fileURLToPath(new URL('../../../public/worlds/', import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/** Lugano as the GLO-30 re-bake ships it: bake credits → manifest → destination (syncDestinations). */
function luganoOnGlo30(): Destination {
  const world = { ...readJson(join(WORLDS, 'lugano/manifest.json')), credits: creditsFor(GLO30_DEM_SOURCE) };
  return validateDestination(destinationFromWorld(readJson(join(DEST_DIR, 'lugano.json')), world), 'lugano.json');
}
const perugia = () => validateDestination(readJson(join(DEST_DIR, 'perugia.json')), 'perugia.json');

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** Every element under `node`, depth first. */
function elements(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const child of node) elements(child, out);
  else if (isValidElement(node)) {
    out.push(node as El);
    elements((node as El).props.children, out);
  }
  return out;
}

/** The text a reader gets from `node` (strings and numbers in tree order). */
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement(node)) return text((node as El).props.children);
  return '';
}

function render(destinations: readonly Destination[]) {
  const tree = WorldCredits({ destinations }) as El | null;
  const rows = elements(tree).filter((el) => typeof el.props['data-credit'] === 'string');
  return {
    tree,
    rows: rows.map((el) => ({
      id: el.props['data-credit'] as string,
      /** The row's visible lines (its <p>s): name, notice, licence. */
      lines: elements(el.props.children).filter((p) => p.type === 'p').map((p) => text(p).replace(/\s+/g, ' ').trim()),
      text: text(el).replace(/\s+/g, ' '),
      hrefs: elements(el).flatMap((a) => (a.type === 'a' ? [a.props.href as string] : [])),
    })),
  };
}

const survey: WorldCredit = {
  id: 'test-survey',
  name: 'Test Survey 1:5000',
  attribution: '© Test Survey Office 2031',
  licence: 'Test Open Licence 9.9; no warranty given by the Test Survey Office.',
  url: 'https://survey.example.test/licence',
};
const place = (id: string, name: string, credits: WorldCredit[]): Destination => ({
  ...perugia(),
  id,
  name,
  role: 'wishlist',
  world: null,
  routes: [`scenic-${id}`],
  credits,
});

describe('WorldCredits: a GLO-30 world carries the licence notice to the screen', () => {
  const lugano = luganoOnGlo30();
  const { rows } = render([perugia(), lugano]);
  const glo30 = rows.find((r) => r.id === 'copernicus-glo30');

  it('the GLO-30 destination brings its credit along (bake → manifest → destination)', () => {
    expect(lugano.credits.map((c) => c.id)).toEqual(['osm', 'copernicus-glo30', 'copernicus-glo90', 'osrm-fossgis']);
    expect(glo30).toBeDefined();
  });

  it('renders the Art. 6(c) liability sentence and the 6(b) notice as text', () => {
    expect(glo30!.text).toContain(GLO30_DISCLAIMER);
    expect(glo30!.text).toContain(
      'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30',
    );
    expect(glo30!.text).toContain(GLO30_CREDIT.attribution);
    expect(glo30!.text).toContain(
      'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
    );
    expect(glo30!.lines).toEqual([GLO30_CREDIT.name, GLO30_CREDIT.attribution, `Licence ${GLO30_CREDIT.licence}`]);
  });

  it('links each credit to its own source, in a new tab', () => {
    expect(glo30!.hrefs).toEqual([GLO30_CREDIT.url]);
    const links = elements(render([perugia(), lugano]).tree).filter((el) => el.type === 'a');
    expect(links.map((a) => [a.props.target, a.props.rel])).toEqual(links.map(() => ['_blank', 'noopener noreferrer']));
  });

  it('says which places each credit covers', () => {
    expect(glo30!.text).toContain('Used for Lugano');
    expect(rows.find((r) => r.id === 'terrain-tiles')!.text).toContain('Used for Perugia');
    expect(rows.find((r) => r.id === 'osm')!.text).toContain('Used for every place');
  });

  it('is a disclosure, collapsed by default, titled "Map & terrain credits"', () => {
    const tree = WorldCredits({ destinations: [lugano] }) as El;
    expect(tree.type).toBe('details');
    expect(tree.props.open).toBeUndefined();
    const summary = elements(tree).find((el) => el.type === 'summary')!;
    expect(text(summary).replace('›', '').trim()).toBe('Map & terrain credits');
  });
});

describe('WorldCredits: the list comes from Destination.credits', () => {
  it('renders exactly the credits it is given, every field, in first-seen order', () => {
    const { rows } = render([place('alpha', 'Alpha', [survey])]);
    expect(rows.map((r) => r.id)).toEqual(['test-survey']);
    expect(rows[0].lines).toEqual([survey.name, survey.attribution, `Licence ${survey.licence}`]);
    expect(rows[0].hrefs).toEqual([survey.url]);
  });

  it('follows the input: other credits, other rows; none, no disclosure', () => {
    const a = render([place('alpha', 'Alpha', [survey])]).rows.map((r) => r.id);
    const b = render([perugia()]).rows.map((r) => r.id);
    expect(a).not.toEqual(b);
    expect(b).toEqual(perugia().credits.map((c) => c.id));
    expect(WorldCredits({ destinations: [] })).toBeNull();
  });

  it('defaults to every shipped destination, deduplicated by id', () => {
    const tree = WorldCredits({}) as El;
    const ids = elements(tree).flatMap((el) => (typeof el.props['data-credit'] === 'string' ? [el.props['data-credit'] as string] : []));
    expect(ids).toEqual([...new Set(DESTINATIONS.flatMap((d) => d.credits.map((c) => c.id)))]);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('renders each shipped credit\'s name, notice and licence', () => {
    const { rows } = render(DESTINATIONS);
    for (const credit of new Map(DESTINATIONS.flatMap((d) => d.credits.map((c) => [c.id, c] as const))).values()) {
      const row = rows.find((r) => r.id === credit.id)!;
      expect(row.lines).toEqual([credit.name, credit.attribution, `Licence ${credit.licence}`]);
      expect(row.hrefs).toEqual([credit.url]);
    }
  });
});

describe('worldCredits / creditPlaces (pure)', () => {
  it('dedupes by id across destinations and lists the places in Home order', () => {
    const entries = worldCredits([place('alpha', 'Alpha', [survey]), place('beta', 'Beta', [survey, { ...survey, id: 'other', name: 'Other' }])]);
    expect(entries.map((e) => [e.key, e.places])).toEqual([
      ['test-survey', ['Alpha', 'Beta']],
      ['other', ['Beta']],
    ]);
  });

  it('keeps both texts when one id carries different text, so no licence is dropped', () => {
    const changed = { ...survey, licence: 'Test Open Licence 10.0' };
    const entries = worldCredits([place('alpha', 'Alpha', [survey]), place('beta', 'Beta', [changed])]);
    expect(entries.map((e) => [e.key, e.credit.licence, e.places])).toEqual([
      ['test-survey', survey.licence, ['Alpha']],
      ['test-survey-2', changed.licence, ['Beta']],
    ]);
  });

  it('phrases the places', () => {
    expect(creditPlaces(['Perugia', 'Lugano'], 2)).toBe('Used for every place');
    expect(creditPlaces(['Lugano'], 14)).toBe('Used for Lugano');
    expect(creditPlaces(['Perugia', 'Lugano'], 14)).toBe('Used for Perugia and Lugano');
    expect(creditPlaces(['Perugia', 'Lugano', 'Garda'], 14)).toBe('Used for Perugia, Lugano and Garda');
    expect(creditPlaces(['Perugia'], 1)).toBe('Used for Perugia');
  });
});

describe('Home mounts the credits, the ride does not', () => {
  it('Home renders <WorldCredits /> in its footer, right after the map-data line', async () => {
    vi.resetModules();
    vi.doMock('react', async (importOriginal) => {
      const actual = await importOriginal<typeof import('react')>();
      const useEffect = () => {};
      return { ...actual, default: { ...actual, useEffect }, useEffect };
    });
    vi.doMock('react-router-dom', async (importOriginal) => ({
      ...(await importOriginal<typeof import('react-router-dom')>()),
      useNavigate: () => () => {},
      useLocation: () => ({ pathname: '/app', search: '' }),
    }));
    const [{ Home }, { WorldCredits: Mounted }] = await Promise.all([import('@/routes/Home'), import('./WorldCredits')]);
    const all = elements(Home() as El);
    const footer = all.find((el) => el.type === 'footer')!;
    const kids = elements(footer.props.children);
    const at = kids.findIndex((el) => el.type === Mounted);
    expect(at).toBeGreaterThan(0);
    expect(text(kids[at - 1])).toContain('© OpenStreetMap contributors');
    expect(all.filter((el) => el.type === Mounted)).toHaveLength(1);
    vi.doUnmock('react');
    vi.doUnmock('react-router-dom');
  });

  it('no file but Home mounts it (the ride HUD stays minimal)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) ? [p] : [];
      });
    const mounts = walk(join(ROOT, 'src'))
      .filter((f) => readFileSync(f, 'utf8').includes('<WorldCredits'))
      .map((f) => relative(ROOT, f));
    expect(mounts).toEqual(['src/routes/Home.tsx']);
  });
});
