/**
 * "Next episode without a picker": re-open what the rider picked last time
 * (a folder or a set of files, remembered as File System Access handles in
 * IndexedDB) and choose where to carry on (showLibrary.nextUp).
 *
 * Chrome keeps read access for the session; after a restart it asks once
 * with a small permission prompt (not a file picker), and never again once
 * the rider picks "Allow on every visit". With `ask: false` this only
 * succeeds when no prompt is needed at all.
 */

import {
  fileKey,
  filesFromLibrary,
  lastWatched,
  nextUp,
  recallLibrary,
  sortForPlayback,
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
  read?: (lib: RememberedLibrary, opts: { ask: boolean }) => Promise<File[]>;
  storage?: Storage;
}

/** Re-open last time's videos at the right one. Null: nothing remembered, no access, or all watched. */
export async function continueLastShow(
  { ask }: { ask: boolean },
  deps: ContinueDeps = {},
): Promise<ContinuePlan | null> {
  const lib = await (deps.recall ?? recallLibrary)();
  if (!lib) return null;
  let files: File[];
  try {
    files = await (deps.read ?? filesFromLibrary)(lib, { ask });
  } catch {
    return null;
  }
  return planContinue(files, deps.storage);
}
