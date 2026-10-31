/**
 * Show mode's local video library: picking files, remembering where you
 * stopped, and (where Chrome allows it) reopening last time's videos with one
 * tap. Everything stays on this device.
 *
 * - Resume positions live in localStorage under the globeride.* prefix so
 *   backups carry them. Keyed by file name + size, so re-picking the same
 *   file with the plain file input also resumes.
 * - File System Access handles (Chrome/Edge desktop) live in a tiny separate
 *   IndexedDB database; they cannot be serialised into a backup anyway.
 */

import { openDB, type IDBPDatabase } from 'idb';

export const RESUME_STORAGE_KEY = 'globeride.velo.showResume.v1';
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
