import { beforeEach, describe, expect, it, vi } from 'vitest';
import { continueLastShow, planContinue } from '@/lib/show/continueShow';
import {
  LAST_WATCHED_KEY,
  fileKey,
  lastWatched,
  libraryAllowed,
  libraryFromStored,
  libraryName,
  markWatched,
  nextUp,
  readLibrary,
  saveResume,
  type RememberedLibrary,
} from '@/lib/show/showLibrary';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

/** A video file whose key (name + size) is distinct per episode. */
const ep = (name: string, size: number): File => new File([new Uint8Array(size)], name, { type: 'video/mp4' });

const s01 = ep('Show S01E01.mp4', 101);
const s02 = ep('Show S01E02.mp4', 102);
const s10 = ep('Show S01E10.mp4', 110);

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
});

const watched = (f: File, positionS: number, durationS: number, ended = false, at = 1) =>
  markWatched({ key: fileKey(f), name: f.name, positionS, durationS, ended }, at, store);

describe('last watched', () => {
  it('remembers the video and whether it was finished', () => {
    expect(lastWatched(store)).toBeNull();
    watched(s01, 120, 1500);
    expect(lastWatched(store)).toMatchObject({ key: fileKey(s01), finished: false });
    // Within the last 20 s counts as finished (end credits).
    watched(s01, 1490, 1500);
    expect(lastWatched(store)?.finished).toBe(true);
    watched(s02, 10, 1500, true);
    expect(lastWatched(store)).toMatchObject({ key: fileKey(s02), finished: true });
  });

  it('ignores junk in storage', () => {
    store.setItem(LAST_WATCHED_KEY, '{"key":3}');
    expect(lastWatched(store)).toBeNull();
    store.setItem(LAST_WATCHED_KEY, 'not json');
    expect(lastWatched(store)).toBeNull();
  });
});

describe('nextUp', () => {
  const items = [s01, s02, s10].map((f) => ({ key: fileKey(f) }));

  it('starts at the first video with no history', () => {
    expect(nextUp(items, null, store)).toEqual({ index: 0, positionS: 0, reason: 'first' });
  });

  it('carries on with a video watched part-way, at the saved position', () => {
    saveResume({ key: fileKey(s02), name: s02.name, positionS: 600, durationS: 1500 }, 5, store);
    watched(s02, 600, 1500);
    expect(nextUp(items, lastWatched(store), store)).toEqual({ index: 1, positionS: 600, reason: 'continue' });
  });

  it('moves to the next episode after a finished one', () => {
    watched(s02, 1500, 1500, true);
    expect(nextUp(items, lastWatched(store), store)).toEqual({ index: 2, positionS: 0, reason: 'next' });
  });

  it('has nothing left after the last episode', () => {
    watched(s10, 1500, 1500, true);
    expect(nextUp(items, lastWatched(store), store)).toBeNull();
  });

  it('falls back to the most recently paused video when the last one is not in this list', () => {
    saveResume({ key: fileKey(s01), name: s01.name, positionS: 30, durationS: 1500 }, 1, store);
    saveResume({ key: fileKey(s10), name: s10.name, positionS: 90, durationS: 1500 }, 9, store);
    const other = { key: 'elsewhere::1', name: 'x', finished: false, savedAt: 1 };
    expect(nextUp(items, other, store)).toEqual({ index: 2, positionS: 90, reason: 'resume' });
  });
});

describe('planContinue', () => {
  it('plans in playback order (E02 before E10), whatever order the files arrive in', () => {
    watched(s02, 1500, 1500, true);
    const plan = planContinue([s10, s01, s02], store);
    expect(plan?.startKey).toBe(fileKey(s10));
    expect(plan?.next.reason).toBe('next');
  });

  it('is null with no files or nothing left', () => {
    expect(planContinue([], store)).toBeNull();
    watched(s10, 1500, 1500, true);
    expect(planContinue([s01, s02, s10], store)).toBeNull();
  });
});

describe('continueLastShow (no picker)', () => {
  const folder = { kind: 'folder', dir: { name: 'Show S01', kind: 'directory' } } as unknown as RememberedLibrary;
  const got = (files: File[], denied = false) => async () => ({ files, denied });

  it('re-opens the remembered library at the next episode, asking with the click it was given', async () => {
    watched(s01, 1500, 1500, true);
    let asked: boolean | null = null;
    const result = await continueLastShow(
      { ask: true },
      {
        recall: async () => folder,
        read: async (_lib, o) => {
          asked = o.ask;
          return { files: [s01, s02, s10], denied: false };
        },
        storage: store,
      },
    );
    expect(asked).toBe(true);
    expect(result.ok && result.plan.startKey).toBe(fileKey(s02));
  });

  // Review of PR #36 @bbe04db, D4: every failure used to read "You have
  // watched everything from last time". Each one now says what happened.
  it("none: nothing remembered, or the browser's storage can't be read", async () => {
    expect(await continueLastShow({ ask: true }, { recall: async () => null, storage: store })).toEqual({
      ok: false,
      reason: 'none',
      library: null,
    });
    const broken = await continueLastShow(
      { ask: true },
      {
        recall: async () => {
          throw new DOMException('IndexedDB unavailable', 'InvalidStateError');
        },
        storage: store,
      },
    );
    expect(broken).toMatchObject({ ok: false, reason: 'none' });
  });

  it('denied: Chrome refused access and nothing could be read', async () => {
    const r = await continueLastShow({ ask: true }, { recall: async () => folder, read: got([], true), storage: store });
    expect(r).toEqual({ ok: false, reason: 'denied', library: folder });
  });

  it('missing: the videos or the folder are gone (or the handles no longer read)', async () => {
    expect(await continueLastShow({ ask: true }, { recall: async () => folder, read: got([]), storage: store })).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    const thrown = await continueLastShow(
      { ask: true },
      {
        recall: async () => folder,
        read: async () => {
          throw new DOMException('gone', 'NotFoundError');
        },
        storage: store,
      },
    );
    expect(thrown).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('done: only when every video was watched to the end', async () => {
    watched(s10, 1500, 1500, true);
    const r = await continueLastShow({ ask: true }, { recall: async () => folder, read: got([s01, s02, s10]), storage: store });
    expect(r).toMatchObject({ ok: false, reason: 'done' });
    // Some refused but some readable: carry on with what is there.
    watched(s01, 300, 1500);
    const partial = await continueLastShow({ ask: true }, { recall: async () => folder, read: got([s01], true), storage: store });
    expect(partial.ok && partial.plan.startKey).toBe(fileKey(s01));
  });
});

/** A remembered handle with Chrome's permission methods (state per call). */
function handle(
  name: string,
  opts: { state?: PermissionState; onAsk?: PermissionState | Error; file?: File | Error } = {},
) {
  const request = vi.fn(async () => {
    if (opts.onAsk instanceof Error) throw opts.onAsk;
    return opts.onAsk ?? 'granted';
  });
  return {
    kind: 'file' as const,
    name,
    queryPermission: vi.fn(async () => opts.state ?? 'granted'),
    requestPermission: request,
    getFile: vi.fn(async () => {
      if (opts.file instanceof Error) throw opts.file;
      return opts.file ?? ep(name, 100);
    }),
  };
}

describe('re-opening the remembered handles (Chrome permissions)', () => {
  it('asks Chrome again only with a click (ask), and only when access is not granted already', async () => {
    const h = handle('a.mp4', { state: 'prompt', onAsk: 'granted' });
    expect(await libraryAllowed(h as unknown as FileSystemHandle, { ask: false })).toBe(false);
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(await libraryAllowed(h as unknown as FileSystemHandle, { ask: true })).toBe(true);
    expect(h.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
    const already = handle('b.mp4', { state: 'granted' });
    expect(await libraryAllowed(already as unknown as FileSystemHandle, { ask: true })).toBe(true);
    expect(already.requestPermission).not.toHaveBeenCalled();
  });

  it('files: refused ones count as denied, deleted ones are skipped; the rest play in order', async () => {
    const lib = {
      kind: 'files',
      handles: [
        handle('Show S01E10.mp4', { state: 'prompt', onAsk: 'granted' }),
        handle('Show S01E02.mp4', { state: 'prompt', onAsk: 'denied' }),
        handle('Show S01E01.mp4', { file: new DOMException('gone', 'NotFoundError') }),
        handle('Show S01E03.mp4'),
      ],
    } as unknown as RememberedLibrary;
    const read = await readLibrary(lib, { ask: true });
    expect(read.denied).toBe(true);
    expect(read.refused).toEqual(['Show S01E02.mp4']);
    expect(read.files.map((f) => f.name)).toEqual(['Show S01E03.mp4', 'Show S01E10.mp4']);
  });

  it("a request Chrome rejects (no click left to ask with) is a refusal, not a crash", async () => {
    const lib = {
      kind: 'files',
      handles: [handle('a.mp4', { state: 'prompt', onAsk: new DOMException('User activation is required', 'SecurityError') })],
    } as unknown as RememberedLibrary;
    expect(await readLibrary(lib, { ask: true })).toEqual({ files: [], denied: true, refused: ['a.mp4'] });
  });

  it('folder: refused, moved, or still there', async () => {
    const dir = (opts: { state?: PermissionState; onAsk?: PermissionState; entries?: unknown[] | Error }) => ({
      kind: 'directory',
      name: 'Show S01',
      queryPermission: vi.fn(async () => opts.state ?? 'granted'),
      requestPermission: vi.fn(async () => opts.onAsk ?? 'granted'),
      values: async function* () {
        if (opts.entries instanceof Error) throw opts.entries;
        for (const e of opts.entries ?? []) yield e;
      },
    });
    const refused = { kind: 'folder', dir: dir({ state: 'prompt', onAsk: 'denied' }) } as unknown as RememberedLibrary;
    expect(await readLibrary(refused, { ask: true })).toEqual({ files: [], denied: true });
    const moved = { kind: 'folder', dir: dir({ entries: new DOMException('gone', 'NotFoundError') }) } as unknown as RememberedLibrary;
    expect(await readLibrary(moved, { ask: true })).toEqual({ files: [], denied: false });
    const there = {
      kind: 'folder',
      dir: dir({ state: 'prompt', onAsk: 'granted', entries: [handle('Show S01E02.mp4'), handle('Show S01E01.mp4'), handle('notes.txt', { file: new File(['x'], 'notes.txt', { type: 'text/plain' }) })] }),
    } as unknown as RememberedLibrary;
    const read = await readLibrary(there, { ask: true });
    expect(read.denied).toBe(false);
    expect(read.files.map((f) => f.name)).toEqual(['Show S01E01.mp4', 'Show S01E02.mp4']);
  });
});

// Review of PR #36 @61defbb, F1: a library of several files after a browser
// restart, where Chrome allows some handles and refuses the rest (once the
// click's activation is used up after the first prompt, Chrome throws). The
// real readLibrary, so the refused names come from the handles. Continue starts
// what it would start with every file allowed, or says access was refused.
describe('several files, Chrome refuses some of them after a restart', () => {
  const noClick = () => new DOMException('User activation is required', 'SecurityError');
  const allowed = (name: string) => handle(name, { state: 'granted' });
  const refusedH = (name: string) => handle(name, { state: 'prompt', onAsk: noClick() });
  /** Watched to the end (true) or part-way (false); the episode files are 100 bytes (handle()). */
  const seen = (name: string, finished: boolean, at = 1) =>
    markWatched({ key: fileKey(ep(name, 100)), name, positionS: finished ? 1500 : 300, durationS: 1500 }, at, store);
  const cont = (handles: ReturnType<typeof handle>[]) =>
    continueLastShow(
      { ask: true },
      { recall: async () => ({ kind: 'files', handles }) as unknown as RememberedLibrary, read: readLibrary, storage: store },
    );

  it('A: E01 watched, E02 and E03 refused: access refused, not "watched everything"', async () => {
    seen('Show S01E01.mp4', true);
    const r = await cont([
      handle('Show S01E01.mp4', { state: 'prompt', onAsk: 'granted' }),
      refusedH('Show S01E02.mp4'),
      refusedH('Show S01E03.mp4'),
    ]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('B: E01 watched, E02 refused, E03 allowed: never skips E02', async () => {
    seen('Show S01E01.mp4', true);
    const r = await cont([allowed('Show S01E01.mp4'), refusedH('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(r.ok && r.plan.startKey).not.toBe(fileKey(ep('Show S01E03.mp4', 100)));
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('never "watched everything" while Chrome refused one, even when the rest were all watched', async () => {
    seen('Show S01E03.mp4', true);
    const r = await cont([refusedH('Show S01E01.mp4'), allowed('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
    // A reader that can't name the refused files: still not 'done'.
    const unnamed = await continueLastShow(
      { ask: true },
      { recall: async () => ({ kind: 'files', handles: [] }) as unknown as RememberedLibrary, read: async () => ({ files: [ep('Show S01E03.mp4', 100)], denied: true }), storage: store },
    );
    expect(unnamed).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('the video watched part-way last time is the refused one: access refused, not another episode', async () => {
    seen('Show S01E02.mp4', false);
    const r = await cont([allowed('Show S01E01.mp4'), refusedH('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('a refused video paused more recently than the others: access refused, not an older one', async () => {
    saveResume({ key: fileKey(ep('Show S01E03.mp4', 100)), name: 'Show S01E03.mp4', positionS: 200, durationS: 1500 }, 1, store);
    saveResume({ key: fileKey(ep('Show S01E02.mp4', 100)), name: 'Show S01E02.mp4', positionS: 400, durationS: 1500 }, 9, store);
    // Last watched something that is not in this library.
    markWatched({ key: 'Other.mp4::5', name: 'Other.mp4', positionS: 10, durationS: 1500 }, 10, store);
    const r = await cont([allowed('Show S01E01.mp4'), refusedH('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('carries on when the refusal changes nothing: the episode after a refused, finished one', async () => {
    seen('Show S01E02.mp4', true);
    const r = await cont([allowed('Show S01E01.mp4'), refusedH('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(r.ok && r.plan.startKey).toBe(fileKey(ep('Show S01E03.mp4', 100)));
    // next.index points into the files that will play (E01, E03), not the whole library.
    expect(r.ok && r.plan.next).toEqual({ index: 1, positionS: 0, reason: 'next' });
  });

  it('carries on past a refused episode that comes before last time\'s (already watched)', async () => {
    seen('Show S01E02.mp4', true);
    const r = await cont([refusedH('Show S01E01.mp4'), allowed('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(r.ok && r.plan.startKey).toBe(fileKey(ep('Show S01E03.mp4', 100)));
    seen('Show S01E02.mp4', false);
    const again = await cont([refusedH('Show S01E01.mp4'), allowed('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(again.ok && again.plan).toMatchObject({ startKey: fileKey(ep('Show S01E02.mp4', 100)), next: { reason: 'continue' } });
  });
});

describe('remembered library records', () => {
  it('reads a folder record or a list of file handles; rejects junk', () => {
    const dir = { name: 'Show S01', kind: 'directory' };
    const lib = libraryFromStored({ kind: 'folder', dir });
    expect(lib?.kind).toBe('folder');
    expect(libraryName(lib!)).toBe('Show S01');
    const files = libraryFromStored([{ name: 'a.mp4', kind: 'file' }]);
    expect(files?.kind).toBe('files');
    expect(libraryName(files!)).toBe('a.mp4');
    expect(libraryFromStored([])).toBeNull();
    expect(libraryFromStored({ kind: 'folder' })).toBeNull();
    expect(libraryFromStored('x')).toBeNull();
    expect(libraryFromStored(null)).toBeNull();
  });
});
