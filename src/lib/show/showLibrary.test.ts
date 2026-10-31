import { beforeEach, describe, expect, it } from 'vitest';
import {
  RESUME_STORAGE_KEY,
  fileKey,
  formatClock,
  isVideoFile,
  latestResume,
  resumePosition,
  saveResume,
  sortForPlayback,
  titleFromFileName,
} from '@/lib/show/showLibrary';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
});

describe('file helpers', () => {
  it('keys files by name and size', () => {
    expect(fileKey({ name: 'a.mp4', size: 10 })).toBe('a.mp4::10');
    expect(fileKey({ name: 'a.mp4', size: 10 })).not.toBe(fileKey({ name: 'a.mp4', size: 11 }));
  });

  it('turns file names into titles', () => {
    expect(titleFromFileName('The.Office.S02E01.mp4')).toBe('The Office S02E01');
    expect(titleFromFileName('my_show__ep_3.webm')).toBe('my show ep 3');
    expect(titleFromFileName('.mp4')).toBe('.mp4');
  });

  it('orders episodes naturally', () => {
    const files = ['Ep 10.mp4', 'Ep 2.mp4', 'ep 1.mp4'].map((name) => ({ name }));
    expect(sortForPlayback(files).map((f) => f.name)).toEqual(['ep 1.mp4', 'Ep 2.mp4', 'Ep 10.mp4']);
  });

  it('recognises video files by type or extension', () => {
    expect(isVideoFile({ name: 'x.bin', type: 'video/mp4' })).toBe(true);
    expect(isVideoFile({ name: 'x.MKV', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });

  it('formats clock times', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(754)).toBe('12:34');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('resume positions', () => {
  const ep = { key: 'ep1.mp4::99', name: 'ep1', durationS: 1800 };

  it('saves and reads a position', () => {
    saveResume({ ...ep, positionS: 754 }, 1, store);
    expect(resumePosition(ep.key, store)).toBe(754);
    expect(store.getItem(RESUME_STORAGE_KEY)).toContain('ep1');
  });

  it('forgets videos watched to the end or barely started', () => {
    saveResume({ ...ep, positionS: 754 }, 1, store);
    saveResume({ ...ep, positionS: 1790 }, 2, store);
    expect(resumePosition(ep.key, store)).toBe(0);
    saveResume({ ...ep, positionS: 2 }, 3, store);
    expect(latestResume(store)).toBeNull();
  });

  it('returns the most recently watched video', () => {
    saveResume({ ...ep, positionS: 100 }, 1, store);
    saveResume({ key: 'ep2::1', name: 'ep2', durationS: 900, positionS: 300 }, 5, store);
    expect(latestResume(store)?.name).toBe('ep2');
  });

  it('survives corrupt storage', () => {
    store.setItem(RESUME_STORAGE_KEY, '{not json');
    expect(resumePosition('x', store)).toBe(0);
    expect(latestResume(store)).toBeNull();
    saveResume({ ...ep, positionS: 60 }, 1, store);
    expect(resumePosition(ep.key, store)).toBe(60);
  });

  it('keeps the list bounded', () => {
    for (let i = 0; i < 80; i++) {
      saveResume({ key: `k${i}`, name: `n${i}`, durationS: 1000, positionS: 100 }, i, store);
    }
    const map = JSON.parse(store.getItem(RESUME_STORAGE_KEY)!) as Record<string, unknown>;
    expect(Object.keys(map)).toHaveLength(50);
    expect(map.k79).toBeDefined();
    expect(map.k0).toBeUndefined();
  });
});
