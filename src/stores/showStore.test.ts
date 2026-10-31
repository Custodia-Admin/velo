import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The persist middleware needs localStorage at import time in the node env.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
});

const { useShowStore, showIsPlaying, retainShowForRide } = await import('@/stores/showStore');

const created: string[] = [];
const revoked: string[] = [];

function file(name: string, size = 10): File {
  return { name, size, type: 'video/mp4' } as unknown as File;
}

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  let n = 0;
  vi.stubGlobal('URL', {
    createObjectURL: () => {
      const u = `blob:${++n}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => void revoked.push(u),
  });
  useShowStore.getState().endShow();
  revoked.length = 0;
});

afterEach(() => {
  useShowStore.getState().endShow();
});

describe('showStore', () => {
  it('starts show mode with the panel open and the auto camera on', () => {
    useShowStore.getState().startShow(1234);
    const s = useShowStore.getState();
    expect(s.active).toBe(true);
    expect(s.panelOpen).toBe(true);
    expect(s.autoCamera).toBe(true);
    expect(s.startedAtMs).toBe(1234);
  });

  it('keeps the original start time if started again', () => {
    useShowStore.getState().startShow(1000);
    useShowStore.getState().startShow(9000);
    expect(useShowStore.getState().startedAtMs).toBe(1000);
  });

  it('loads files in natural order', () => {
    useShowStore.getState().loadFiles([file('Ep 10.mp4'), file('Ep 2.mp4')]);
    const s = useShowStore.getState();
    expect(s.source).toBe('files');
    expect(s.items.map((i) => i.title)).toEqual(['Ep 2', 'Ep 10']);
    expect(s.index).toBe(0);
  });

  it('ignores an empty pick', () => {
    useShowStore.getState().loadFiles([]);
    expect(useShowStore.getState().source).toBe('none');
  });

  it('advances through the list and stops at the end', () => {
    const st = useShowStore.getState();
    st.loadFiles([file('a.mp4'), file('b.mp4')]);
    expect(useShowStore.getState().next()).toBe(true);
    expect(useShowStore.getState().index).toBe(1);
    expect(useShowStore.getState().next()).toBe(false);
    expect(useShowStore.getState().index).toBe(1);
  });

  it('releases video files when a new pick replaces them and when show mode ends', () => {
    const st = useShowStore.getState();
    st.loadFiles([file('a.mp4')]);
    st.loadFiles([file('b.mp4')]);
    expect(revoked).toEqual([created[0]]);
    useShowStore.getState().endShow();
    expect(revoked).toEqual([created[0], created[1]]);
    const s = useShowStore.getState();
    expect(s.active).toBe(false);
    expect(s.items).toEqual([]);
    expect(s.startedAtMs).toBeNull();
  });

  it('switches to picture-in-picture with the panel hidden and show mode still on', () => {
    const st = useShowStore.getState();
    st.startShow(1);
    st.loadFiles([file('a.mp4')]);
    useShowStore.getState().usePip();
    const s = useShowStore.getState();
    expect(s.active).toBe(true);
    expect(s.source).toBe('pip');
    expect(s.panelOpen).toBe(false);
    expect(revoked).toHaveLength(1);
  });

  it('restores the auto camera for the next show', () => {
    const st = useShowStore.getState();
    st.startShow(1);
    st.setAutoCamera(false);
    useShowStore.getState().endShow();
    useShowStore.getState().startShow(2);
    expect(useShowStore.getState().autoCamera).toBe(true);
  });

  it('reports playing only while show mode is on', () => {
    useShowStore.getState().setPlaying(true);
    expect(showIsPlaying()).toBe(false);
    useShowStore.getState().startShow(1);
    useShowStore.getState().setPlaying(true);
    expect(showIsPlaying()).toBe(true);
  });

  it('persists only the panel size', () => {
    useShowStore.getState().setSize('l');
    useShowStore.getState().startShow(1);
    const saved = JSON.parse(mem.get('globeride.velo.show.v1') ?? '{}') as { state: object };
    expect(saved.state).toEqual({ size: 'l' });
  });

  it('survives a StrictMode remount of the ride view but ends when the ride view goes', () => {
    vi.useFakeTimers();
    try {
      useShowStore.getState().loadFiles([file('a.mp4')]);
      useShowStore.getState().startShow(1);
      // StrictMode: mount, unmount, mount again.
      const r1 = retainShowForRide();
      r1();
      const r2 = retainShowForRide();
      vi.runAllTimers();
      expect(useShowStore.getState().active).toBe(true);
      expect(useShowStore.getState().items).toHaveLength(1);
      // Real unmount.
      r2();
      r2();
      vi.runAllTimers();
      expect(useShowStore.getState().active).toBe(false);
      expect(useShowStore.getState().items).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
