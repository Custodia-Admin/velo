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
  pickVideoHandles,
  rememberHandles,
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
