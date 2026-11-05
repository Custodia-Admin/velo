/**
 * Picking videos remembers them, so "Continue" (continueShow) can reopen
 * them next ride without a picker: the files' handles, or the folder.
 * Review of PR #36 @bbe04db, C7/C8: dropping either remember call left every
 * test green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  picker: true,
  handles: [] as { name: string; getFile: () => Promise<File> }[],
  dir: null as { name: string } | null,
  folderFiles: [] as File[],
  rememberHandles: vi.fn(async (_h: unknown) => undefined),
  rememberFolder: vi.fn(async (_d: unknown) => undefined),
}));

vi.mock('@/lib/show/showLibrary', async (orig) => ({
  ...(await orig<typeof import('@/lib/show/showLibrary')>()),
  canUseFilePicker: () => h.picker,
  pickVideoHandles: async () => h.handles,
  pickVideoFolder: async () => h.dir,
  videosInFolder: async () => h.folderFiles,
  rememberHandles: h.rememberHandles,
  rememberFolder: h.rememberFolder,
}));

const { pickVideoFolderFiles, pickVideos } = await import('./pickVideos');

const video = (name: string) => new File([new Uint8Array(4)], name, { type: 'video/mp4' });

beforeEach(() => {
  h.rememberHandles.mockClear();
  h.rememberFolder.mockClear();
  h.picker = true;
  h.handles = [];
  h.dir = null;
  h.folderFiles = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('picking videos (File System Access)', () => {
  it('remembers the picked files for next time and returns the videos', async () => {
    const a = video('Show S01E01.mp4');
    const b = video('Show S01E02.mp4');
    h.handles = [
      { name: a.name, getFile: async () => a },
      { name: b.name, getFile: async () => b },
    ];
    expect(await pickVideos()).toEqual([a, b]);
    expect(h.rememberHandles).toHaveBeenCalledTimes(1);
    expect(h.rememberHandles).toHaveBeenCalledWith(h.handles);
  });

  it('a cancelled pick remembers nothing', async () => {
    expect(await pickVideos()).toEqual([]);
    expect(h.rememberHandles).not.toHaveBeenCalled();
  });

  // Review of PR #48 @dfd7071, N1: Chrome's picker keeps "All files", and a
  // remembered subtitle that Chrome later refuses blocked Continue.
  it('remembers only the videos of a pick that also holds a subtitle', async () => {
    const a = video('Show S01E01.mp4');
    const srt = new File(['1'], 'Show S01E01.srt', { type: 'text/plain' });
    const b = video('Show S01E02.mp4');
    h.handles = [a, srt, b].map((f) => ({ name: f.name, getFile: async () => f }));
    expect(await pickVideos()).toEqual([a, b]);
    expect(h.rememberHandles).toHaveBeenCalledWith([h.handles[0], h.handles[2]]);
  });

  it('a pick with no video keeps last time\'s library', async () => {
    const srt = new File(['1'], 'Show S01E01.srt', { type: 'text/plain' });
    h.handles = [{ name: srt.name, getFile: async () => srt }];
    expect(await pickVideos()).toEqual([]);
    expect(h.rememberHandles).not.toHaveBeenCalled();
  });

  // Review of PR #56 @b31487c, Y5: Chrome types .3gp, .f4v and .qt as video
  // (video/3gpp, video/mp4, video/quicktime), and they play. A pick of them is
  // last time's library: remembering by name alone forgot it, so Continue
  // reopened an older pick or nothing.
  it('remembers videos known by their type only (.3gp, .f4v)', async () => {
    const a = new File([new Uint8Array(4)], 'Show S01E01.3gp', { type: 'video/3gpp' });
    const b = new File([new Uint8Array(4)], 'Show S01E02.f4v', { type: 'video/mp4' });
    h.handles = [a, b].map((f) => ({ name: f.name, getFile: async () => f }));
    expect(await pickVideos()).toEqual([a, b]);
    expect(h.rememberHandles).toHaveBeenCalledWith(h.handles);
  });

  it('remembers a picked folder, and returns its videos', async () => {
    h.dir = { name: 'Show S01' };
    h.folderFiles = [video('Show S01E01.mp4')];
    expect(await pickVideoFolderFiles()).toEqual(h.folderFiles);
    expect(h.rememberFolder).toHaveBeenCalledWith(h.dir);
  });

  it('a cancelled folder pick remembers nothing', async () => {
    expect(await pickVideoFolderFiles()).toBeNull();
    expect(h.rememberFolder).not.toHaveBeenCalled();
  });
});

/** A document whose <input type=file> "picks" `files` when clicked. */
function fileInputDocument(files: File[]) {
  const inputs: { accept: string; multiple: boolean; removed: boolean }[] = [];
  return {
    inputs,
    doc: {
      createElement: () => {
        const listeners = new Map<string, () => void>();
        const input = {
          type: '',
          accept: '',
          multiple: false,
          hidden: false,
          removed: false,
          files: null as File[] | null,
          setAttribute: () => undefined,
          addEventListener: (ev: string, cb: () => void) => listeners.set(ev, cb),
          remove: () => {
            input.removed = true;
          },
          click: () => {
            input.files = files;
            listeners.get('change')?.();
          },
        };
        inputs.push(input);
        return input;
      },
      body: { appendChild: () => undefined },
    },
  };
}

// Review of PR #56 @b31487c, Y6: no test drove the plain file input (Firefox,
// Safari, phones) with a file that is not a video.
describe('picking videos (plain file input)', () => {
  it('returns only the videos, and remembers nothing', async () => {
    h.picker = false;
    const srt = new File(['1'], 'Show S01E01.srt', { type: 'application/x-subrip' });
    const a = video('Show S01E01.mp4');
    const { doc, inputs } = fileInputDocument([srt, a]);
    vi.stubGlobal('document', doc);
    expect(await pickVideos()).toEqual([a]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ multiple: true, removed: true });
    expect(h.rememberHandles).not.toHaveBeenCalled();
  });
});
