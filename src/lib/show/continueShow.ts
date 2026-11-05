/**
 * "Next episode without a picker": re-open what the rider picked last time
 * (a folder or a set of files, remembered as File System Access handles in
 * IndexedDB) and choose where to carry on (showLibrary.nextUp).
 *
 * Chrome keeps read access for the session; after a restart it asks once
 * with a small permission prompt (not a file picker), and never again once
 * the rider picks "Allow on every visit". With `ask: false` this only
 * succeeds when no prompt is needed at all.
 *
 * When it can't carry on it says why, so the chooser tells the truth
 * (ShowPanel): nothing remembered, access refused, the videos gone, or
 * everything watched.
 */

import {
  fileKey,
  lastWatched,
  nextUp,
  readLibrary,
  recallLibrary,
  sortForPlayback,
  type LibraryRead,
  type NextUp,
  type RememberedLibrary,
} from '@/lib/show/showLibrary';

export interface ContinuePlan {
  files: File[];
  /** Key of the video to start with (showStore.loadFiles startKey). */
  startKey: string;
  next: NextUp;
}

/**
 * Why there is nothing to carry on with:
 * - `none`: nothing remembered on this device (or its storage is unavailable);
 * - `denied`: Chrome refused access to the remembered videos;
 * - `missing`: the videos (or the folder) are no longer where they were;
 * - `done`: every video from last time was watched to the end.
 */
export type ContinueFailure = 'none' | 'denied' | 'missing' | 'done';

export type ContinueResult =
  | { ok: true; plan: ContinuePlan }
  | { ok: false; reason: ContinueFailure; library: RememberedLibrary | null };

/**
 * Pure part: the plan for a set of re-opened files (in the order the player
 * uses), or null when nothing is left to watch.
 */
export function planContinue(files: File[], storage?: Storage): ContinuePlan | null {
  if (files.length === 0) return null;
  const items = sortForPlayback(files).map((f) => ({ key: fileKey(f) }));
  const next = nextUp(items, lastWatched(storage), storage);
  if (!next) return null;
  return { files, startKey: items[next.index].key, next };
}

export interface ContinueDeps {
  recall?: () => Promise<RememberedLibrary | null>;
  read?: (lib: RememberedLibrary, opts: { ask: boolean }) => Promise<LibraryRead>;
  storage?: Storage;
}

/** Re-open last time's videos at the right one, or say why it can't. */
export async function continueLastShow({ ask }: { ask: boolean }, deps: ContinueDeps = {}): Promise<ContinueResult> {
  let lib: RememberedLibrary | null;
  try {
    lib = await (deps.recall ?? recallLibrary)();
  } catch {
    lib = null;
  }
  if (!lib) return { ok: false, reason: 'none', library: null };
  let read: LibraryRead;
  try {
    read = await (deps.read ?? readLibrary)(lib, { ask });
  } catch {
    // Reading the handles failed outright: they no longer point anywhere.
    return { ok: false, reason: 'missing', library: lib };
  }
  if (read.files.length === 0) return { ok: false, reason: read.denied ? 'denied' : 'missing', library: lib };
  const plan = planContinue(read.files, deps.storage);
  return plan ? { ok: true, plan } : { ok: false, reason: 'done', library: lib };
}
