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
  let files: File[];
  if (canUseFilePicker()) {
    const handles = await pickVideoHandles();
    if (handles.length === 0) return [];
    files = await Promise.all(handles.map((h) => h.getFile()));
    void rememberHandles(handles);
  } else {
    files = await pickWithInput();
  }
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
