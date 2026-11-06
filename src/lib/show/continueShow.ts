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
 * everything watched. When Chrome allows some of several files and refuses
 * the rest, it carries on only if the video it would start with full access
 * is one it can read; otherwise it says access was refused, never "watched
 * everything". It asks Chrome about that video first (askPlannedFirst), since
 * only the first ask after a restart is sure to have the click behind it.
 */

import {
  fileKey,
  lastWatched,
  mayBeVideoName,
  nextUp,
  readLibrary,
  recallLibrary,
  resumeEntries,
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
 * - `denied`: Chrome refused access to the remembered videos (all of them, or
 *   the one to carry on with, or some of them once the rest were watched);
 * - `missing`: the videos (or the folder) are no longer where they were;
 * - `done`: every video from last time was watched to the end (and Chrome
 *   allowed them all).
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
  const pick = pickInLibrary(files, [], storage);
  return pick && pick.file ? planFor(files, pick.file, pick.next) : null;
}

/** One video of last time's library; `file` is null for one Chrome refused. */
interface LibraryItem {
  name: string;
  key: string;
  file: File | null;
}

/**
 * What nextUp picks from the whole library, in playback order: the files that
 * could be read plus the ones Chrome refused, so a refusal never changes which
 * video Continue starts. A refused file can't be read, so only its name is
 * known (no size for fileKey): it takes the key of last time's video, or of a
 * saved position, with the same name.
 */
function pickInLibrary(
  files: File[],
  refused: readonly string[],
  storage?: Storage,
): (LibraryItem & { next: NextUp }) | null {
  const last = lastWatched(storage);
  const known = [...(last ? [last] : []), ...resumeEntries(storage)];
  const keyOf = (name: string) => known.find((k) => k.name === name)?.key ?? `${name}::refused`;
  const items = sortForPlayback<LibraryItem>([
    ...files.map((file) => ({ name: file.name, key: fileKey(file), file })),
    ...refused.map((name) => ({ name, key: keyOf(name), file: null })),
  ]);
  const next = nextUp(items, last, storage);
  return next ? { ...items[next.index], next } : null;
}

/** The plan to start `file`; `next.index` points into the files in playback order. */
function planFor(files: File[], file: File, next: NextUp): ContinuePlan {
  const startKey = fileKey(file);
  const index = sortForPlayback(files).findIndex((f) => fileKey(f) === startKey);
  return { files, startKey, next: { ...next, index } };
}

/**
 * The remembered files with the video Continue expects to start moved to the
 * front, so it is the one Chrome asks about first. After a browser restart
 * only the first permission request has the click's user activation; the rest
 * are refused. Read in stored order, the click went to E01 (usually watched
 * already) and E02, the one to carry on with, was refused. The handles' names
 * are enough to plan (pickInLibrary keys names from last time's video and the
 * saved positions); the real plan is still made from what Chrome allowed.
 */
function askPlannedFirst(lib: RememberedLibrary, storage?: Storage): RememberedLibrary {
  if (lib.kind !== 'files') return lib;
  // The same test readLibrary uses for a refused file, so the episode asked
  // for first is the one a refusal would block on.
  const names = lib.handles.map((h) => h.name).filter(mayBeVideoName);
  const planned = pickInLibrary([], names, storage);
  const at = planned ? lib.handles.findIndex((h) => h.name === planned.name) : -1;
  if (at <= 0) return lib;
  return { kind: 'files', handles: [lib.handles[at], ...lib.handles.slice(0, at), ...lib.handles.slice(at + 1)] };
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
    read = await (deps.read ?? readLibrary)(askPlannedFirst(lib, deps.storage), { ask });
  } catch {
    // Reading the handles failed outright: they no longer point anywhere.
    return { ok: false, reason: 'missing', library: lib };
  }
  if (read.files.length === 0) return { ok: false, reason: read.denied ? 'denied' : 'missing', library: lib };
  const pick = pickInLibrary(read.files, read.refused ?? [], deps.storage);
  // Nothing left among the files Chrome allowed is not "watched everything"
  // while it refused some (review of PR #36 @61defbb, F1).
  if (!pick) return { ok: false, reason: read.denied ? 'denied' : 'done', library: lib };
  // The video to carry on with is one Chrome refused: never skip past it.
  if (!pick.file) return { ok: false, reason: 'denied', library: lib };
  return { ok: true, plan: planFor(read.files, pick.file, pick.next) };
}
