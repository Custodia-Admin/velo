import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { DESTINATIONS, validateDestination, type Destination } from '@/lib/world/destinations';
import type { WorldCredit } from '@/lib/world/manifest';
import { GLO30_CREDIT, GLO30_DISCLAIMER } from '../../../tools/worldbake/fetchGlo30.mjs';
import { GLO30_DEM_SOURCE } from '../../../tools/worldbake/demSource.mjs';
import { bundleCredits } from '../../../tools/worldbake/bake.mjs';
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
const REMOTE = fileURLToPath(new URL('../../../tools/worldbake/remote/', import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/** Lugano as the GLO-30 re-bake ships it: bake credits → manifest → destination (syncDestinations). */
function luganoOnGlo30(): Destination {
  // The bake's own credits for Lugano's recipe: GLO-30, plus swissALTI3D under the routes (recipe bareGround, card t_06b010ec).
  const recipe = readJson(fileURLToPath(new URL('../../../tools/worldbake/worlds/lugano.json', import.meta.url)));
  const world = { ...readJson(join(WORLDS, 'lugano/manifest.json')), credits: bundleCredits(recipe, GLO30_DEM_SOURCE, {}) };
  // Its outlying routes ride in remote worlds of their own (extraWorlds), each from its committed manifest.
  const dest = readJson(join(DEST_DIR, 'lugano.json')) as { extraWorlds: { id: string; dir: string }[] };
  const extras = dest.extraWorlds.map((w) => ({ world: readJson(join(REMOTE, w.id, 'manifest.json')), remote: { dir: w.dir } }));
  return validateDestination(destinationFromWorld(dest, world, null, extras), 'lugano.json');
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

/** The credit rows of a rendered disclosure. */
function rowsOf(tree: El | null) {
  return elements(tree)
    .filter((el) => typeof el.props['data-credit'] === 'string')
    .map((el) => ({
      id: el.props['data-credit'] as string,
      /** The row's visible lines (its <p>s): name, notice, licence. */
      lines: elements(el.props.children).filter((p) => p.type === 'p').map((p) => text(p).replace(/\s+/g, ' ').trim()),
      text: text(el).replace(/\s+/g, ' '),
      hrefs: elements(el).flatMap((a) => (a.type === 'a' ? [a.props.href as string] : [])),
    }));
}

function render(destinations: readonly Destination[]) {
  const tree = WorldCredits({ destinations }) as El | null;
  return { tree, rows: rowsOf(tree) };
}

/** Each credit id once, in first-seen order: what the disclosure lists for `destinations`. */
const dedupedIds = (destinations: readonly Destination[]) => [...new Set(destinations.flatMap((d) => d.credits.map((c) => c.id)))];

const HIDING_CLASSES = ['hidden', 'sr-only', 'invisible', 'opacity-0', 'text-transparent'];

/**
 * Why `el` would not reach a sighted reader: a `hidden` or `aria-hidden` prop,
 * or a class that hides it (`hidden`, `sr-only`, `invisible`, `opacity-0`,
 * `text-transparent`, under any variant such as `sm:hidden`). Null when it shows.
 */
function hides(el: El): string | null {
  const { hidden, className } = el.props;
  const aria = el.props['aria-hidden'];
  if (hidden !== undefined && hidden !== false) return 'hidden';
  if (aria !== undefined && aria !== false && aria !== 'false') return 'aria-hidden';
  const cls = typeof className === 'string'
    ? className.split(/\s+/).find((c) => HIDING_CLASSES.includes(c.split(':').pop()!.replace(/^!/, '')))
    : undefined;
  return cls ? `class "${cls}"` : null;
}

type Leaf = { text: string; path: El[] };
/** Every non-blank text under `node`, with the elements above it (outermost first). */
function leaves(node: ReactNode, path: El[] = [], out: Leaf[] = []): Leaf[] {
  if (typeof node === 'string' || typeof node === 'number') {
    if (String(node).trim()) out.push({ text: String(node).trim(), path });
  } else if (Array.isArray(node)) for (const child of node) leaves(child, path, out);
  else if (isValidElement(node)) leaves((node as El).props.children, [...path, node as El], out);
  return out;
}

/**
 * What would keep the disclosure's text off the screen: for the summary label
 * and every row's name, notice, licence and places (the Source link's own
 * screen-reader copy aside), each element on the path from the `details` root
 * that hides it. The chevron is the one element allowed to be aria-hidden.
 */
function hiddenText(tree: El) {
  const all = leaves(tree);
  const inSummary = all.filter((l) => l.path.some((el) => el.type === 'summary'));
  const chevron = inSummary.filter((l) => l.text === '›');
  const label = inSummary.filter((l) => l.text !== '›');
  const inRows = all.filter(
    (l) => l.path.some((el) => typeof el.props['data-credit'] === 'string') && !l.path.some((el) => el.type === 'a'),
  );
  const blocked = [...label, ...inRows].flatMap((l) =>
    l.path.flatMap((el) => {
      const why = hides(el);
      return why ? [`"${l.text.slice(0, 40)}": <${typeof el.type === 'string' ? el.type : 'component'}> ${why}`] : [];
    }),
  );
  return {
    blocked,
    label: label.map((l) => l.text).join(' '),
    rowText: inRows.map((l) => l.text).join(' '),
    /** What hides the chevron, outermost first: only its own aria-hidden. */
    chevron: chevron.map((l) => l.path.map(hides).filter(Boolean)),
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
    expect(lugano.credits.map((c) => c.id).slice(0, 5)).toEqual(['osm', 'copernicus-glo30', 'swissalti3d', 'copernicus-glo90', 'osrm-fossgis']);
    // Then what its extra worlds add: their routes and Lombardy's bare ground.
    expect(lugano.credits.map((c) => c.id).slice(5)).toEqual([
      'route-scenic-valle-maggia',
      'route-scenic-magadino-plain',
      'lombardia-dtm5',
      'route-scenic-lake-varese',
      'route-scenic-lake-como-menaggio',
    ]);
    expect(glo30).toBeDefined();
  });

  it('is the Lugano that ships: the committed destination already carries the GLO-30 credit (re-bake t_49b58e90)', () => {
    expect(validateDestination(readJson(join(DEST_DIR, 'lugano.json')), 'lugano.json')).toEqual(lugano);
    expect(DESTINATIONS.find((d) => d.id === 'lugano')?.credits).toEqual(lugano.credits);
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
    // Perugia's Trasimeno world is baked on GLO-30 too.
    expect(glo30!.text).toContain('Used for every place');
    expect(rows.find((r) => r.id === 'swissalti3d')!.text).toContain('Used for Lugano');
    expect(rows.find((r) => r.id === 'mase-pst-lidar')!.text).toContain('Used for Perugia');
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

  it('nothing hides the summary or a row\'s name, notice and licence (only the chevron is aria-hidden)', () => {
    const seen = hiddenText(WorldCredits({ destinations: [perugia(), lugano] }) as El);
    expect(seen.blocked).toEqual([]);
    expect(seen.label).toBe('Map & terrain credits');
    expect(seen.chevron).toEqual([['aria-hidden']]);
    for (const credit of new Map([...perugia().credits, ...lugano.credits].map((c) => [c.id, c] as const)).values()) {
      for (const line of [credit.name, credit.attribution, credit.licence]) expect(seen.rowText).toContain(line);
    }
    expect(seen.rowText).toContain(GLO30_DISCLAIMER);
  });

  it('the visibility check itself flags every hiding class, under any variant, and nothing else', () => {
    const el = (className: string) => ({ type: 'p', props: { className } }) as unknown as El;
    for (const cls of HIDING_CLASSES) {
      for (const variant of [cls, `sm:${cls}`, `group-open:!${cls}`]) expect(hides(el(`text-sm ${variant}`))).toBe(`class "${variant}"`);
    }
    for (const shown of ['opacity-50', 'text-foreground', 'block', 'hover:opacity-80']) expect(hides(el(shown))).toBeNull();
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
    expect(ids).toEqual(dedupedIds(DESTINATIONS));
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

/**
 * Home() called as a function (effects off, router stubbed), with the
 * shipped DESTINATIONS swapped for `destinations` when given. Returns Home's
 * elements, the WorldCredits element(s) it mounts with the path down to them,
 * and that WorldCredits rendered with the props Home passes.
 */
async function renderHome(destinations?: readonly Destination[]) {
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
  if (destinations) {
    vi.doMock('@/lib/world/destinations', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/world/destinations')>()),
      DESTINATIONS: destinations,
    }));
  }
  try {
    const [{ Home }, { WorldCredits: Mounted }] = await Promise.all([import('@/routes/Home'), import('./WorldCredits')]);
    const root = Home() as El;
    const all = elements(root);
    const mounts = all.filter((el) => el.type === Mounted);
    /** Elements from Home's root down to (not including) the first mount. */
    const pathTo = (node: ReactNode, path: El[] = []): El[] | null => {
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = pathTo(child, path);
          if (hit) return hit;
        }
      } else if (isValidElement(node)) {
        if (node.type === Mounted) return path;
        return pathTo((node as El).props.children, [...path, node as El]);
      }
      return null;
    };
    const credits = mounts.length ? (Mounted(mounts[0].props as Parameters<typeof Mounted>[0]) as El | null) : null;
    return { all, Mounted, mounts, above: pathTo(root) ?? [], credits };
  } finally {
    vi.doUnmock('react');
    vi.doUnmock('react-router-dom');
    vi.doUnmock('@/lib/world/destinations');
    vi.resetModules();
  }
}

describe('Home mounts the credits, the ride does not', () => {
  it('Home renders <WorldCredits /> in its footer, right after the map-data line', async () => {
    const { all, Mounted } = await renderHome();
    const footer = all.find((el) => el.type === 'footer')!;
    const kids = elements(footer.props.children);
    const at = kids.findIndex((el) => el.type === Mounted);
    expect(at).toBeGreaterThan(0);
    expect(text(kids[at - 1])).toContain('© OpenStreetMap contributors');
    expect(all.filter((el) => el.type === Mounted)).toHaveLength(1);
  });

  it('with props that list every shipped credit, shown (not an empty or hidden disclosure)', async () => {
    const { credits, above } = await renderHome();
    expect(credits).not.toBeNull();
    const rows = rowsOf(credits);
    expect(rows.map((r) => r.id)).toEqual(dedupedIds(DESTINATIONS));
    for (const credit of new Map(DESTINATIONS.flatMap((d) => d.credits.map((c) => [c.id, c] as const))).values()) {
      expect(rows.find((r) => r.id === credit.id)!.lines).toEqual([credit.name, credit.attribution, `Licence ${credit.licence}`]);
    }
    expect(above.flatMap((el) => hides(el) ?? [])).toEqual([]);
    expect(hiddenText(credits!).blocked).toEqual([]);
  });

  it('a GLO-30 world anywhere in DESTINATIONS reaches Home with its Art. 6 notice (bake → manifest → destination → Home)', async () => {
    const lugano = luganoOnGlo30();
    const { credits } = await renderHome([perugia(), lugano]);
    const rows = rowsOf(credits);
    expect(rows.map((r) => r.id)).toEqual(dedupedIds([perugia(), lugano]));
    const glo30 = rows.find((r) => r.id === 'copernicus-glo30');
    expect(glo30, 'Home lists the GLO-30 credit of a destination after the first').toBeDefined();
    expect(glo30!.text).toContain(GLO30_DISCLAIMER);
    expect(glo30!.text).toContain(GLO30_CREDIT.attribution);
    expect(glo30!.lines).toEqual([GLO30_CREDIT.name, GLO30_CREDIT.attribution, `Licence ${GLO30_CREDIT.licence}`]);
    expect(glo30!.text).toContain('Used for every place');
  });

  it('lists a credit that only a later destination carries (the default is every destination, not the first)', async () => {
    const other: WorldCredit = { ...survey, id: 'test-other', name: 'Other Survey' };
    const { credits } = await renderHome([place('alpha', 'Alpha', [survey]), place('beta', 'Beta', [survey, other])]);
    expect(rowsOf(credits).map((r) => [r.id, r.lines[0]])).toEqual([
      ['test-survey', survey.name],
      ['test-other', other.name],
    ]);
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
