/**
 * Ask the rider for one or more local video files.
 *
 * Chrome / Edge desktop: the File System Access picker, and the handles are
 * remembered so "Continue" can reopen them next ride. Everywhere else: a
 * plain <input type=file multiple>. Must be called from a click handler.
 */

import {
  canUseFilePicker,
  isVideoFile,
  pickVideoFolder,
  pickVideoHandles,
  rememberFolder,
  rememberHandles,
  videosInFolder,
} from '@/lib/show/showLibrary';

function pickWithInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,.mkv,.mov';
    input.multiple = true;
    input.hidden = true;
    input.setAttribute('data-show-file-input', '');
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export async function pickVideos(): Promise<File[]> {
  if (!canUseFilePicker()) return (await pickWithInput()).filter(isVideoFile);
  const handles = await pickVideoHandles();
  if (handles.length === 0) return [];
  const files = await Promise.all(handles.map((h) => h.getFile()));
  // Remember only the videos: a subtitle picked with Chrome's "All files" is
  // not an episode, and Continue must never wait for it (review of PR #48
  // @dfd7071, N1). A pick with no video keeps last time's library.
  const videos = handles.filter((_, i) => isVideoFile(files[i]));
  if (videos.length > 0) void rememberHandles(videos);
  return files.filter(isVideoFile);
}

/**
 * Ask for a folder of episodes (Chrome / Edge desktop). The folder is
 * remembered, so the next episode in it opens next time without a picker.
 * Null when the rider cancels; [] when it holds no playable videos.
 */
export async function pickVideoFolderFiles(): Promise<File[] | null> {
  const dir = await pickVideoFolder();
  if (!dir) return null;
  void rememberFolder(dir);
  return videosInFolder(dir);
}
