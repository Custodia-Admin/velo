/**
 * Picking videos remembers them, so "Continue" (continueShow) can reopen
 * them next ride without a picker: the files' handles, or the folder.
 * Review of PR #36 @bbe04db, C7/C8: dropping either remember call left every
 * test green.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handles: [] as { name: string; getFile: () => Promise<File> }[],
  dir: null as { name: string } | null,
  folderFiles: [] as File[],
  rememberHandles: vi.fn(async (_h: unknown) => undefined),
  rememberFolder: vi.fn(async (_d: unknown) => undefined),
}));

vi.mock('@/lib/show/showLibrary', async (orig) => ({
  ...(await orig<typeof import('@/lib/show/showLibrary')>()),
  canUseFilePicker: () => true,
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
  h.handles = [];
  h.dir = null;
  h.folderFiles = [];
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
