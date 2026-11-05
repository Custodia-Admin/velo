/**
 * Home's "Ride and watch" (ScenicHome useRideWithShow): carry on with last
 * time's videos without a picker, asking Chrome with the rider's click; pick
 * videos only when there is nothing to carry on with.
 * Review of PR #36 @bbe04db, C4/C5: Home never continuing, or never asking
 * Chrome, left every test green.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  continueLastShow: vi.fn(),
  pickVideos: vi.fn(async () => [] as File[]),
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));
vi.mock('@/lib/show/continueShow', async (orig) => ({
  ...(await orig<typeof import('@/lib/show/continueShow')>()),
  continueLastShow: h.continueLastShow,
}));
vi.mock('@/lib/show/pickVideos', () => ({ pickVideos: h.pickVideos, pickVideoFolderFiles: vi.fn() }));

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
});

const { useRideWithShow } = await import('./ScenicHome');
const { useShowStore } = await import('@/stores/showStore');
const { useRideStore } = await import('@/stores/rideStore');
const { scenicRouteById } = await import('@/lib/scenicRoutes');
const { fileKey } = await import('@/lib/show/showLibrary');

const assisi = scenicRouteById('scenic-assisi-valley')!;
const video = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: 'video/mp4' });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  h.navigate.mockClear();
  h.continueLastShow.mockReset();
  h.pickVideos.mockReset();
  h.pickVideos.mockResolvedValue([]);
  vi.stubGlobal('URL', { createObjectURL: (f: File) => `blob:${f.name}`, revokeObjectURL: () => undefined });
  useShowStore.getState().endShow();
});

describe('Home: ride and watch', () => {
  it('carries on with last time’s videos at the planned episode, with no picker', async () => {
    const a = video('Show S01E01.mp4', 11);
    const b = video('Show S01E02.mp4', 12);
    h.continueLastShow.mockResolvedValue({
      ok: true,
      plan: { files: [a, b], startKey: fileKey(b), next: { index: 1, positionS: 0, reason: 'next' } },
    });
    useRideWithShow()(assisi);
    await flush();
    // Asked with the rider's click: Chrome may show its one-line permission prompt.
    expect(h.continueLastShow).toHaveBeenCalledWith({ ask: true });
    expect(h.pickVideos).not.toHaveBeenCalled();
    const s = useShowStore.getState();
    expect(s.items[s.index].key).toBe(fileKey(b));
    expect(useRideStore.getState().route?.id).toBe(assisi.route.id);
    expect(h.navigate).toHaveBeenCalledWith('/ride', { state: { autoStart: true, show: true } });
  });

  it('with nothing to carry on with, picks videos first; a cancelled pick stays on Home', async () => {
    h.continueLastShow.mockResolvedValue({ ok: false, reason: 'none', library: null });
    useRideWithShow()(assisi);
    await flush();
    expect(h.pickVideos).toHaveBeenCalledTimes(1);
    expect(h.navigate).not.toHaveBeenCalled();

    const c = video('Film.mp4', 9);
    h.pickVideos.mockResolvedValue([c]);
    useRideWithShow()(assisi);
    await flush();
    expect(useShowStore.getState().items.map((it) => it.key)).toEqual([fileKey(c)]);
    expect(h.navigate).toHaveBeenCalledWith('/ride', { state: { autoStart: true, show: true } });
  });
});
