/**
 * Show mode's local video library: picking files, remembering where you
 * stopped, and (where Chrome allows it) reopening last time's videos with one
 * tap. Everything stays on this device.
 *
 * - Resume positions live in localStorage under the globeride.* prefix so
 *   backups carry them. Keyed by file name + size, so re-picking the same
 *   file with the plain file input also resumes.
 * - File System Access handles (Chrome/Edge desktop) live in a tiny separate
 *   IndexedDB database; they cannot be serialised into a backup anyway. A
 *   picked folder is remembered the same way, so the next episode in it
 *   opens next time without a picker (Chrome may ask once to allow access
 *   again after a restart; "Allow on every visit" makes it silent).
 * - The last thing watched (and whether it was finished) lives in
 *   localStorage, so "next episode" survives a reload.
 */

import { openDB, type IDBPDatabase } from 'idb';

export const RESUME_STORAGE_KEY = 'globeride.velo.showResume.v1';
export const LAST_WATCHED_KEY = 'globeride.velo.showLast.v1';
const HANDLE_DB = 'velo-show';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'last';
/** Positions older than this many seconds from the end count as finished. */
const FINISHED_TAIL_S = 20;
/** Keep the resume map small. */
const MAX_RESUME_ENTRIES = 50;

/** Stable identity for a local file across picks. */
export function fileKey(file: { name: string; size: number }): string {
  return `${file.name}::${file.size}`;
}

/** Display title for a file: name without extension, separators as spaces. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  const spaced = base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.length > 0 ? spaced : name;
}

/** Natural order so "Episode 2" plays before "Episode 10". */
export function sortForPlayback<T extends { name: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export function isVideoFile(file: { name: string; type: string }): boolean {
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|m4v|webm|mkv|mov|ogv)$/i.test(file.name);
}

export interface ResumeEntry {
  key: string;
  name: string;
  positionS: number;
  durationS: number;
  savedAt: number;
}

type ResumeMap = Record<string, ResumeEntry>;

function readMap(storage: Storage | undefined): ResumeMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(RESUME_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as ResumeMap) : {};
  } catch {
    return {};
  }
}

function defaultStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

/** Save the playback position for a file. Near the end counts as finished. */
export function saveResume(
  entry: Omit<ResumeEntry, 'savedAt'>,
  now: number = Date.now(),
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  const map = readMap(storage);
  const finished =
    entry.durationS > 0 && entry.positionS >= entry.durationS - FINISHED_TAIL_S;
  if (finished || entry.positionS < 5) {
    delete map[entry.key];
  } else {
    map[entry.key] = { ...entry, savedAt: now };
  }
  const trimmed = Object.values(map)
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_RESUME_ENTRIES);
  try {
    storage.setItem(
      RESUME_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(trimmed.map((e) => [e.key, e]))),
    );
  } catch {
    // Quota or private mode: resuming is a nicety, never block playback.
  }
}

export function resumePosition(
  key: string,
  storage: Storage | undefined = defaultStorage(),
): number {
  const e = readMap(storage)[key];
  return e && Number.isFinite(e.positionS) ? e.positionS : 0;
}

/** Most recently watched unfinished file, if any. */
export function latestResume(
  storage: Storage | undefined = defaultStorage(),
): ResumeEntry | null {
  const entries = Object.values(readMap(storage));
  if (entries.length === 0) return null;
  return entries.reduce((a, b) => (b.savedAt > a.savedAt ? b : a));
}

/** "12:34" or "1:02:03". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---------------------------------------------------------------------------
// Last watched and what plays next
// ---------------------------------------------------------------------------

export interface LastWatched {
  key: string;
  name: string;
  /** Watched to the end (or within the last FINISHED_TAIL_S). */
  finished: boolean;
  savedAt: number;
}

/** Remember the video the rider is on (called with the resume saves). */
export function markWatched(
  entry: { key: string; name: string; positionS: number; durationS: number; ended?: boolean },
  now: number = Date.now(),
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  const finished =
    entry.ended === true || (entry.durationS > 0 && entry.positionS >= entry.durationS - FINISHED_TAIL_S);
  const value: LastWatched = { key: entry.key, name: entry.name, finished, savedAt: now };
  try {
    storage.setItem(LAST_WATCHED_KEY, JSON.stringify(value));
  } catch {
    // Quota or private mode: never block playback.
  }
}

export function lastWatched(storage: Storage | undefined = defaultStorage()): LastWatched | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_WATCHED_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<LastWatched>) : null;
    if (!v || typeof v.key !== 'string' || typeof v.name !== 'string') return null;
    return { key: v.key, name: v.name, finished: v.finished === true, savedAt: Number(v.savedAt) || 0 };
  } catch {
    return null;
  }
}

export interface NextUp {
  /** Index into the (playback-ordered) list. */
  index: number;
  /** Where to start, seconds (0 = from the beginning). */
  positionS: number;
  /** Why this one: carry on with the same video, or the one after a finished one. */
  reason: 'continue' | 'next' | 'resume' | 'first';
}

/**
 * What to play from `items` (in playback order): the video the rider was
 * part-way through; the one after it when it was finished; otherwise the most
 * recently paused one in the list; otherwise the first. Null when the last
 * video of the list was finished (nothing left).
 */
export function nextUp(
  items: readonly { key: string }[],
  last: LastWatched | null,
  storage: Storage | undefined = defaultStorage(),
): NextUp | null {
  if (items.length === 0) return null;
  const resume = readMap(storage);
  const at = last ? items.findIndex((it) => it.key === last.key) : -1;
  if (last && at >= 0) {
    if (!last.finished) return { index: at, positionS: resume[last.key]?.positionS ?? 0, reason: 'continue' };
    if (at + 1 >= items.length) return null;
    const nextKey = items[at + 1].key;
    return { index: at + 1, positionS: resume[nextKey]?.positionS ?? 0, reason: 'next' };
  }
  let best = -1;
  let bestAt = -Infinity;
  items.forEach((it, i) => {
    const e = resume[it.key];
    if (e && e.savedAt > bestAt) {
      best = i;
      bestAt = e.savedAt;
    }
  });
  if (best >= 0) return { index: best, positionS: resume[items[best].key].positionS, reason: 'resume' };
  return { index: 0, positionS: 0, reason: 'first' };
}

// ---------------------------------------------------------------------------
// File System Access (Chrome / Edge desktop only)
// ---------------------------------------------------------------------------

interface PickerWindow {
  showOpenFilePicker?: (opts: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle[]>;
}

interface PermissionedHandle extends FileSystemFileHandle {
  queryPermission?: (opts: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: 'read' }) => Promise<PermissionState>;
}

export function canUseFilePicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as PickerWindow).showOpenFilePicker === 'function'
  );
}

/** Opens Chrome's file picker. Returns [] when the rider cancels. */
export async function pickVideoHandles(): Promise<FileSystemFileHandle[]> {
  const picker = (window as unknown as PickerWindow).showOpenFilePicker;
  if (!picker) return [];
  try {
    return await picker({
      multiple: true,
      types: [
        {
          description: 'Videos',
          accept: { 'video/*': ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv'] },
        },
      ],
    });
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return [];
    throw err;
  }
}

let handleDb: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  handleDb ??= openDB(HANDLE_DB, 1, {
    upgrade(d) {
      d.createObjectStore(HANDLE_STORE);
    },
  });
  return handleDb;
}

export async function rememberHandles(handles: FileSystemFileHandle[]): Promise<void> {
  try {
    await (await db()).put(HANDLE_STORE, handles, HANDLE_KEY);
  } catch {
    // Structured-clone of handles is Chrome-only; elsewhere just skip.
  }
}

export async function recallHandles(): Promise<FileSystemFileHandle[]> {
  try {
    const v = (await (await db()).get(HANDLE_STORE, HANDLE_KEY)) as unknown;
    return Array.isArray(v) ? (v as FileSystemFileHandle[]) : [];
  } catch {
    return [];
  }
}

/**
 * Re-open remembered handles. Must run inside a click handler: Chrome asks
 * the rider to allow access again after a restart.
 */
export async function filesFromHandles(handles: FileSystemFileHandle[]): Promise<File[]> {
  const files: File[] = [];
  for (const h of handles as PermissionedHandle[]) {
    let state: PermissionState = 'granted';
    if (h.queryPermission) state = await h.queryPermission({ mode: 'read' });
    if (state !== 'granted' && h.requestPermission) {
      state = await h.requestPermission({ mode: 'read' });
    }
    if (state !== 'granted') continue;
    try {
      files.push(await h.getFile());
    } catch {
      // File moved or deleted since last time: skip it.
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// A remembered folder (Chrome / Edge desktop): the episodes in order
// ---------------------------------------------------------------------------

interface DirectoryPickerWindow {
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}

interface IterableDirectory extends FileSystemDirectoryHandle {
  values?: () => AsyncIterableIterator<FileSystemHandle>;
}

interface PermissionedDirectory extends FileSystemDirectoryHandle {
  queryPermission?: (opts: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: 'read' }) => Promise<PermissionState>;
}

export function canPickFolder(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === 'function'
  );
}

/** Opens Chrome's folder picker. Null when the rider cancels. */
export async function pickVideoFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ id: 'velo-shows', mode: 'read' });
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return null;
    throw err;
  }
}

/** The playable videos directly inside a folder, in playback order. */
export async function videosInFolder(dir: FileSystemDirectoryHandle): Promise<File[]> {
  const values = (dir as IterableDirectory).values;
  if (typeof values !== 'function') return [];
  const files: File[] = [];
  for await (const entry of values.call(dir)) {
    if (entry.kind !== 'file') continue;
    try {
      const f = await (entry as FileSystemFileHandle).getFile();
      if (isVideoFile(f)) files.push(f);
    } catch {
      // Unreadable entry (moved, locked): skip it.
    }
  }
  return sortForPlayback(files);
}

export type RememberedLibrary =
  | { kind: 'files'; handles: FileSystemFileHandle[] }
  | { kind: 'folder'; dir: FileSystemDirectoryHandle };

export async function rememberFolder(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    await (await db()).put(HANDLE_STORE, { kind: 'folder', dir }, HANDLE_KEY);
  } catch {
    // Structured-clone of handles is Chrome-only; elsewhere just skip.
  }
}

/** What the rider picked last time: a folder, or a set of files. */
export async function recallLibrary(): Promise<RememberedLibrary | null> {
  try {
    const v = (await (await db()).get(HANDLE_STORE, HANDLE_KEY)) as unknown;
    return libraryFromStored(v);
  } catch {
    return null;
  }
}

/** Reads what IndexedDB holds (an array of file handles, or a folder record). */
export function libraryFromStored(v: unknown): RememberedLibrary | null {
  if (Array.isArray(v)) return v.length > 0 ? { kind: 'files', handles: v as FileSystemFileHandle[] } : null;
  if (v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'folder') {
    const dir = (v as { dir?: unknown }).dir;
    if (dir && typeof dir === 'object') return { kind: 'folder', dir: dir as FileSystemDirectoryHandle };
  }
  return null;
}

/** The library's display name: the folder, or the first file. */
export function libraryName(lib: RememberedLibrary): string {
  return lib.kind === 'folder' ? lib.dir.name : lib.handles[0]?.name ?? '';
}

/**
 * Read permission for a remembered folder or file: 'granted' already (same
 * session, or "Allow on every visit"), or ask once when `ask` is set (needs a
 * click; Chrome shows a small permission prompt, not a picker).
 */
export async function libraryAllowed(
  handle: FileSystemHandle,
  { ask }: { ask: boolean },
): Promise<boolean> {
  const h = handle as PermissionedDirectory;
  let state: PermissionState = 'granted';
  if (h.queryPermission) state = await h.queryPermission({ mode: 'read' });
  if (state !== 'granted' && ask && h.requestPermission) state = await h.requestPermission({ mode: 'read' });
  return state === 'granted';
}

/** What re-opening a remembered library found. */
export interface LibraryRead {
  /** The playable videos still there, in playback order. */
  files: File[];
  /**
   * Chrome refused read access to at least one of them: the rider said no at
   * the prompt, or there was no click to ask with (Chrome throws then).
   */
  denied: boolean;
}

/** Permission, with Chrome's refusals (no click behind the request) counted as a no. */
function allowed(handle: FileSystemHandle, opts: { ask: boolean }): Promise<boolean> {
  return libraryAllowed(handle, opts).catch(() => false);
}

/**
 * Re-open a remembered library without a picker. With `ask: false` it only
 * succeeds when access is still granted (no prompt at all). A folder that
 * moved, or files that were deleted, come back as no files (not denied).
 */
export async function readLibrary(lib: RememberedLibrary, { ask }: { ask: boolean }): Promise<LibraryRead> {
  if (lib.kind === 'folder') {
    if (!(await allowed(lib.dir, { ask }))) return { files: [], denied: true };
    try {
      return { files: await videosInFolder(lib.dir), denied: false };
    } catch {
      // The folder moved or was deleted since last time.
      return { files: [], denied: false };
    }
  }
  const files: File[] = [];
  let denied = false;
  for (const h of lib.handles) {
    if (!(await allowed(h, { ask }))) {
      denied = true;
      continue;
    }
    try {
      files.push(await h.getFile());
    } catch {
      // File moved or deleted since last time: skip it.
    }
  }
  return { files: sortForPlayback(files.filter(isVideoFile)), denied };
}
