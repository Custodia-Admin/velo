import { beforeEach, describe, expect, it } from 'vitest';
import { continueLastShow, planContinue } from '@/lib/show/continueShow';
import {
  LAST_WATCHED_KEY,
  fileKey,
  lastWatched,
  libraryFromStored,
  libraryName,
  markWatched,
  nextUp,
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

  it('re-opens the remembered library at the next episode', async () => {
    watched(s01, 1500, 1500, true);
    let asked: boolean | null = null;
    const plan = await continueLastShow(
      { ask: true },
      {
        recall: async () => folder,
        read: async (_lib, o) => {
          asked = o.ask;
          return [s01, s02, s10];
        },
        storage: store,
      },
    );
    expect(asked).toBe(true);
    expect(plan?.startKey).toBe(fileKey(s02));
  });

  it('is null when nothing is remembered, access is refused, or the files are gone', async () => {
    expect(await continueLastShow({ ask: false }, { recall: async () => null, storage: store })).toBeNull();
    expect(
      await continueLastShow(
        { ask: false },
        {
          recall: async () => folder,
          read: async () => {
            throw new DOMException('denied', 'NotAllowedError');
          },
          storage: store,
        },
      ),
    ).toBeNull();
    expect(
      await continueLastShow({ ask: false }, { recall: async () => folder, read: async () => [], storage: store }),
    ).toBeNull();
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
