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

  // Review of PR #48 @dfd7071, N2: the 'first' branch (nothing of this library
  // watched) had no test, so starting the first READABLE file there survived.
  it("nothing of this library watched yet and E01 refused: access refused, never E02", async () => {
    // Last watched is a file from another library; no saved positions.
    markWatched({ key: 'Other.mp4::5', name: 'Other.mp4', positionS: 10, durationS: 1500 }, 1, store);
    const r = await cont([refusedH('Show S01E01.mp4'), allowed('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
    // Control: with E01 allowed too, Continue starts it from the beginning.
    const all = await cont([allowed('Show S01E01.mp4'), allowed('Show S01E02.mp4'), allowed('Show S01E03.mp4')]);
    expect(all.ok && all.plan).toMatchObject({ startKey: fileKey(ep('Show S01E01.mp4', 100)), next: { reason: 'first', positionS: 0 } });
  });
});

// Review of PR #48 @dfd7071, N1: Chrome's picker keeps its "All files" option,
// so a library of files can hold a subtitle. Refusing it must not block
// Continue: only a refused video counts (readLibrary), and picks remember only
// their videos (pickVideos.test.ts).
describe('a refused file that is not a video', () => {
  const noClick = () => new DOMException('User activation is required', 'SecurityError');
  const srt = (name: string) => handle(name, { state: 'prompt', onAsk: noClick(), file: new File(['1'], name, { type: 'text/plain' }) });
  const cont = (handles: ReturnType<typeof handle>[]) =>
    continueLastShow(
      { ask: true },
      { recall: async () => ({ kind: 'files', handles }) as unknown as RememberedLibrary, read: readLibrary, storage: store },
    );
  const finished = (name: string) => markWatched({ key: fileKey(ep(name, 100)), name, positionS: 1500, durationS: 1500 }, 1, store);

  it('E01 finished, its .srt refused, E02 readable: starts E02', async () => {
    finished('Show S01E01.mp4');
    const handles = [handle('Show S01E01.mp4'), srt('Show S01E01.srt'), handle('Show S01E02.mp4')];
    const read = await readLibrary({ kind: 'files', handles } as unknown as RememberedLibrary, { ask: true });
    expect(read).toMatchObject({ denied: false, refused: [] });
    const r = await cont(handles);
    expect(r.ok && r.plan.startKey).toBe(fileKey(ep('Show S01E02.mp4', 100)));
  });

  it('every video watched and only the .srt refused: watched everything', async () => {
    finished('Show S01E02.mp4');
    const r = await cont([handle('Show S01E01.mp4'), srt('Show S01E01.srt'), handle('Show S01E02.mp4')]);
    expect(r).toMatchObject({ ok: false, reason: 'done' });
  });

  it('a refused video still blocks, whatever the case of its extension', async () => {
    finished('Show S01E01.mp4');
    const r = await cont([handle('Show S01E01.mp4'), srt('Show S01E01.srt'), handle('Show S01E02.MKV', { state: 'prompt', onAsk: noClick() }), handle('Show S01E03.mp4')]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
  });

  // Review of PR #56 @b31487c, Y8: a name that only CONTAINS a video extension.
  it('a refused "Show S01E01.mp4.srt" is not a video: never blocks Continue', async () => {
    finished('Show S01E01.mp4');
    const handles = [handle('Show S01E01.mp4'), srt('Show S01E01.mp4.srt'), handle('Show S01E02.mp4')];
    const read = await readLibrary({ kind: 'files', handles } as unknown as RememberedLibrary, { ask: true });
    expect(read).toMatchObject({ denied: false, refused: [] });
    const r = await cont(handles);
    expect(r.ok && r.plan.startKey).toBe(fileKey(ep('Show S01E02.mp4', 100)));
  });

  it('a readable "Show S01E01.mp4.srt" never joins the playlist', async () => {
    finished('Show S01E01.mp4');
    const sub = handle('Show S01E01.mp4.srt', { file: new File(['1'], 'Show S01E01.mp4.srt', { type: 'application/x-subrip' }) });
    const r = await cont([handle('Show S01E01.mp4'), sub, handle('Show S01E02.mp4')]);
    expect(r.ok && r.plan.files.map((f) => f.name)).toEqual(['Show S01E01.mp4', 'Show S01E02.mp4']);
  });

  it('a library remembered before PR #56 with artwork and notes refused: still carries on', async () => {
    finished('Show S01E01.mp4');
    const r = await cont([handle('Show S01E01.mp4'), srt('folder.jpg'), srt('Show.nfo'), srt('Show S01E01.SRT'), handle('Show S01E02.mp4')]);
    expect(r.ok && r.plan.startKey).toBe(fileKey(ep('Show S01E02.mp4', 100)));
  });

  it('a refused release name with a subtitle tag in the middle is the video: it blocks', async () => {
    finished('Show.S01E01.SUB.ITA.mkv');
    const r = await cont([
      handle('Show.S01E01.SUB.ITA.mkv'),
      handle('Show.S01E02.SUB.ITA.mkv', { state: 'prompt', onAsk: noClick() }),
      handle('Show.S01E03.SUB.ITA.mkv'),
    ]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
  });
});

// Review of PR #56 @b31487c, nit 1: pickVideos remembers a file when its TYPE
// says video (isVideoFile), so Chrome's video/3gpp, video/mp4 or
// video/quicktime files (.3gp, .f4v, .lrv, .qt) are remembered episodes. A
// refused one used to be judged by the picker's extensions alone and dropped:
// Continue started past it (P4) or said everything was watched (P5).
describe('a refused video that is a video by its type only', () => {
  const noClick = () => new DOMException('User activation is required', 'SecurityError');
  const typed = (name: string, type: string) => new File([new Uint8Array(100)], name, { type });
  const allowedT = (name: string, type: string) => handle(name, { file: typed(name, type) });
  const refusedT = (name: string, type: string) => handle(name, { state: 'prompt', onAsk: noClick(), file: typed(name, type) });
  const cont = (handles: ReturnType<typeof handle>[]) =>
    continueLastShow(
      { ask: true },
      { recall: async () => ({ kind: 'files', handles }) as unknown as RememberedLibrary, read: readLibrary, storage: store },
    );
  const finished = (name: string) => markWatched({ key: fileKey(ep(name, 100)), name, positionS: 1500, durationS: 1500 }, 1, store);

  it('P4: nothing of this library watched, E01.3gp refused, E02.3gp readable: access refused, never E02', async () => {
    markWatched({ key: 'Other.mp4::5', name: 'Other.mp4', positionS: 10, durationS: 1500 }, 1, store);
    const r = await cont([refusedT('Show S01E01.3gp', 'video/3gpp'), allowedT('Show S01E02.3gp', 'video/3gpp')]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
    // Control: with E01 allowed too, Continue starts it.
    const all = await cont([allowedT('Show S01E01.3gp', 'video/3gpp'), allowedT('Show S01E02.3gp', 'video/3gpp')]);
    expect(all.ok && all.plan).toMatchObject({ startKey: fileKey(ep('Show S01E01.3gp', 100)), next: { reason: 'first' } });
  });

  it('P5: E01.f4v finished, E02.f4v refused: access refused, never "watched everything"', async () => {
    finished('Show S01E01.f4v');
    const r = await cont([allowedT('Show S01E01.f4v', 'video/mp4'), refusedT('Show S01E02.f4v', 'video/mp4')]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
    // Control: with E02 allowed, Continue starts it.
    const all = await cont([allowedT('Show S01E01.f4v', 'video/mp4'), allowedT('Show S01E02.f4v', 'video/mp4')]);
    expect(all.ok && all.plan.startKey).toBe(fileKey(ep('Show S01E02.f4v', 100)));
  });

  it('.qt and .lrv: E01 finished, E02 refused, E03 readable: never skips E02', async () => {
    finished('Show S01E01.qt');
    const r = await cont([
      allowedT('Show S01E01.qt', 'video/quicktime'),
      refusedT('Show S01E02.qt', 'video/quicktime'),
      allowedT('Show S01E03.qt', 'video/quicktime'),
    ]);
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
    const lrv = await cont([allowedT('Show S01E01.qt', 'video/quicktime'), refusedT('Show S01E02.lrv', 'video/mp4')]);
    expect(lrv).toMatchObject({ ok: false, reason: 'denied' });
  });
});

// Review of PR #48 @dfd7071 (optional item): after a restart Chrome gives the
// click's activation to the first permission request only, and throws for the
// rest. Continue asks for the episode it plans to start first.
describe('one click, one file allowed (after a browser restart)', () => {
  /**
   * Handles sharing one user activation: the first request is allowed, later
   * ones throw. Like Chrome, a handle reads 'granted' once allowed, so a
   * handle asked for twice is read twice (review of PR #56 @b31487c, Y2).
   */
  function oneClick() {
    const asked: string[] = [];
    let used = false;
    const h = (name: string, file?: File) => {
      let granted = false;
      return {
        ...handle(name, { state: 'prompt', file }),
        queryPermission: vi.fn(async () => (granted ? 'granted' : 'prompt') as PermissionState),
        requestPermission: vi.fn(async () => {
          asked.push(name);
          if (used) throw new DOMException('User activation is required', 'SecurityError');
          used = true;
          granted = true;
          return 'granted' as PermissionState;
        }),
      };
    };
    return { asked, h };
  }
  const cont = (handles: { name: string }[]) =>
    continueLastShow(
      { ask: true },
      { recall: async () => ({ kind: 'files', handles }) as unknown as RememberedLibrary, read: readLibrary, storage: store },
    );
  /** Each episode once in what will play. */
  const once = (files: File[]) => expect(new Set(files.map((f) => f.name)).size).toBe(files.length);

  it('E01 finished: asks for E02 first, and starts it', async () => {
    markWatched({ key: fileKey(ep('Show S01E01.mp4', 100)), name: 'Show S01E01.mp4', positionS: 1500, durationS: 1500 }, 1, store);
    const { asked, h } = oneClick();
    const r = await cont([h('Show S01E01.mp4'), h('Show S01E02.mp4'), h('Show S01E03.mp4')]);
    expect(asked[0]).toBe('Show S01E02.mp4');
    expect(r.ok && r.plan).toMatchObject({ startKey: fileKey(ep('Show S01E02.mp4', 100)), next: { reason: 'next' } });
    // Only the one Chrome allowed plays, once.
    expect(r.ok && r.plan.files.map((f) => f.name)).toEqual(['Show S01E02.mp4']);
    // Chrome is asked once per file.
    expect([...asked].sort()).toEqual(['Show S01E01.mp4', 'Show S01E02.mp4', 'Show S01E03.mp4']);
  });

  it('E03 paused part-way: asks for E03 first, and carries on there', async () => {
    saveResume({ key: fileKey(ep('Show S01E03.mp4', 100)), name: 'Show S01E03.mp4', positionS: 420, durationS: 1500 }, 2, store);
    markWatched({ key: fileKey(ep('Show S01E03.mp4', 100)), name: 'Show S01E03.mp4', positionS: 420, durationS: 1500 }, 2, store);
    const { asked, h } = oneClick();
    const r = await cont([h('Show S01E01.mp4'), h('Show S01E02.mp4'), h('Show S01E03.mp4')]);
    expect(asked[0]).toBe('Show S01E03.mp4');
    expect(r.ok && r.plan).toMatchObject({ startKey: fileKey(ep('Show S01E03.mp4', 100)), next: { reason: 'continue', positionS: 420 } });
    if (r.ok) once(r.plan.files);
  });

  // Review of PR #56 @b31487c, nit 1: the episode asked for first is planned
  // with the same name test as a refusal, so a video by type only counts.
  it('a video by its type only (.3gp): asks for E02 first, and starts it', async () => {
    markWatched({ key: fileKey(ep('Show S01E01.3gp', 100)), name: 'Show S01E01.3gp', positionS: 1500, durationS: 1500 }, 1, store);
    const { asked, h } = oneClick();
    const g = (name: string) => h(name, new File([new Uint8Array(100)], name, { type: 'video/3gpp' }));
    const r = await cont([g('Show S01E01.3gp'), g('Show S01E02.3gp'), g('Show S01E03.3gp')]);
    expect(asked[0]).toBe('Show S01E02.3gp');
    expect(r.ok && r.plan.files.map((f) => f.name)).toEqual(['Show S01E02.3gp']);
    expect(r.ok && r.plan.startKey).toBe(fileKey(ep('Show S01E02.3gp', 100)));
  });

  it('never asks for a subtitle first, and still never skips a refused episode', async () => {
    markWatched({ key: fileKey(ep('Show S01E01.mp4', 100)), name: 'Show S01E01.mp4', positionS: 1500, durationS: 1500 }, 1, store);
    const { asked, h } = oneClick();
    // The rider says no at the prompt for E02: E03 must not start.
    const e02 = { ...h('Show S01E02.mp4'), requestPermission: vi.fn(async () => (asked.push('Show S01E02.mp4'), 'denied' as PermissionState)) };
    const r = await cont([h('Show S01E01.mp4'), h('Show S01E01.srt'), e02, h('Show S01E03.mp4')]);
    expect(asked[0]).toBe('Show S01E02.mp4');
    expect(r).toMatchObject({ ok: false, reason: 'denied' });
  });

  // Review of PR #63 @e14ff81, N2 (probes R1/R2): a library remembered before
  // PR #56 can hold release sidecars. One sorting at the planned spot took the
  // click's only grant, and the episode was refused: 3 clicks to start E02.
  it('a sidecar audio track (.mka) beside the next episode: one click asks for E02 and starts it', async () => {
    markWatched({ key: fileKey(ep('Show S01E01.mkv', 100)), name: 'Show S01E01.mkv', positionS: 1500, durationS: 1500 }, 1, store);
    const { asked, h } = oneClick();
    const mka = h('Show S01E02.mka', new File([new Uint8Array(100)], 'Show S01E02.mka', { type: 'audio/x-matroska' }));
    const r = await cont([h('Show S01E01.mkv'), mka, h('Show S01E02.mkv'), h('Show S01E03.mkv')]);
    expect(asked[0]).toBe('Show S01E02.mkv');
    expect(r.ok && r.plan).toMatchObject({ startKey: fileKey(ep('Show S01E02.mkv', 100)), next: { reason: 'next' } });
    expect(r.ok && r.plan.files.map((f) => f.name)).toEqual(['Show S01E02.mkv']);
  });

  it("nothing watched and a folder.ico sorting first: one click asks for E01 and starts it", async () => {
    const { asked, h } = oneClick();
    const ico = h('folder.ico', new File([new Uint8Array(100)], 'folder.ico', { type: 'image/vnd.microsoft.icon' }));
    const r = await cont([ico, h('Show S01E01.mkv'), h('Show S01E02.mkv')]);
    expect(asked[0]).toBe('Show S01E01.mkv');
    expect(r.ok && r.plan).toMatchObject({ startKey: fileKey(ep('Show S01E01.mkv', 100)), next: { reason: 'first' } });
  });
});

// Review of PR #63 @e14ff81, N1: a file Chrome let us READ is kept by its type
// or name (isVideoFile), not by mayBeVideoName, the refused-file test: that one
// says yes to anything not known to be something else. A readable README or
// audio track from an older library, or from a show folder, would join the
// playlist, and README sorts before "Show …", so a 'first' start would open it.
describe('a readable file that is not a video never plays', () => {
  const typed = (name: string, type: string) => new File([new Uint8Array(100)], name, { type });
  const strays = () => [typed('README', ''), typed('Show S01E01.mka', 'audio/x-matroska')];
  const episodes = () => [ep('Show S01E02.mp4', 100), ep('Show S01E01.mp4', 100)];

  it('files: README and an .mka beside the episodes, nothing watched: plays the episodes from E01', async () => {
    const handles = [...strays(), ...episodes()].map((f) => handle(f.name, { file: f }));
    const r = await continueLastShow(
      { ask: true },
      { recall: async () => ({ kind: 'files', handles }) as unknown as RememberedLibrary, read: readLibrary, storage: store },
    );
    expect(r.ok && r.plan.files.map((f) => f.name)).toEqual(['Show S01E01.mp4', 'Show S01E02.mp4']);
    expect(r.ok && r.plan).toMatchObject({ startKey: fileKey(ep('Show S01E01.mp4', 100)), next: { reason: 'first', index: 0 } });
  });

  it('folder: README and an .mka in the show folder, nothing watched: plays the episodes from E01', async () => {
    const files = [...strays(), ...episodes()];
    const dir = {
      kind: 'directory',
      name: 'Show S01',
      queryPermission: vi.fn(async () => 'granted'),
      requestPermission: vi.fn(async () => 'granted'),
      values: async function* () {
        for (const f of files) yield { kind: 'file', name: f.name, getFile: async () => f };
      },
    };
    const r = await continueLastShow(
      { ask: false },
      { recall: async () => ({ kind: 'folder', dir }) as unknown as RememberedLibrary, read: readLibrary, storage: store },
    );
    expect(r.ok && r.plan.files.map((f) => f.name)).toEqual(['Show S01E01.mp4', 'Show S01E02.mp4']);
    expect(r.ok && r.plan).toMatchObject({ startKey: fileKey(ep('Show S01E01.mp4', 100)), next: { reason: 'first', index: 0 } });
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
