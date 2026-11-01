/**
 * Pure parts of useRideExport: the uploaded-ride cache (cap 20, idempotent),
 * the error mapping, the auto-upload gate and one upload run with the FIT
 * builder and the Strava client mocked. No network, no React.
 */
import { describe, expect, it, vi } from 'vitest';

import { StravaError, type UploadState } from '@/lib/strava';
import type { TelemetrySample } from '@/types';
import {
  UPLOADED_CACHE_CAP,
  UPLOADED_CACHE_KEY,
  fitFileName,
  isRideAlreadyUploaded,
  markRideAsUploaded,
  rideKey,
  runStravaUpload,
  shouldAutoUpload,
  stravaActivityName,
  uploadErrorState,
  type AutoUploadInput,
  type StravaUploadDeps,
} from './useRideExport';

function memoryStore(initial?: Record<string, string>) {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    read: () => JSON.parse(data.get(UPLOADED_CACHE_KEY) ?? '[]') as string[],
  };
}

describe('uploaded-ride cache', () => {
  it('keeps the legacy key and cap', () => {
    expect(UPLOADED_CACHE_KEY).toBe('globeride.strava.uploaded.v1');
    expect(UPLOADED_CACHE_CAP).toBe(20);
  });

  it('round-trips a ride key', () => {
    const s = memoryStore();
    expect(isRideAlreadyUploaded('1700000000000', s)).toBe(false);
    markRideAsUploaded('1700000000000', s);
    expect(isRideAlreadyUploaded('1700000000000', s)).toBe(true);
    expect(isRideAlreadyUploaded('1700000000001', s)).toBe(false);
  });

  it('is idempotent: marking twice stores one entry and writes once', () => {
    const s = memoryStore();
    markRideAsUploaded('a', s);
    markRideAsUploaded('a', s);
    expect(s.read()).toEqual(['a']);
    expect(s.setItem).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest entries beyond 20', () => {
    const s = memoryStore();
    for (let i = 0; i < UPLOADED_CACHE_CAP + 5; i++) markRideAsUploaded(`ride-${i}`, s);
    const stored = s.read();
    expect(stored).toHaveLength(UPLOADED_CACHE_CAP);
    expect(stored[0]).toBe('ride-5');
    expect(stored.at(-1)).toBe(`ride-${UPLOADED_CACHE_CAP + 4}`);
    expect(isRideAlreadyUploaded('ride-4', s)).toBe(false);
  });

  it('survives corrupt JSON and a missing store', () => {
    const s = memoryStore({ [UPLOADED_CACHE_KEY]: '{not json' });
    expect(isRideAlreadyUploaded('x', s)).toBe(false);
    expect(() => markRideAsUploaded('x', s)).not.toThrow();
    expect(isRideAlreadyUploaded('x', null)).toBe(false);
    expect(() => markRideAsUploaded('x', null)).not.toThrow();
  });

  it('keys a ride by its start time', () => {
    expect(rideKey(1793547000000)).toBe('1793547000000');
  });
});

describe('uploadErrorState', () => {
  it('keeps a StravaError kind, message and actionUrl', () => {
    const err = new StravaError('Strava credentials are not configured.', 'creds_missing', undefined, undefined, '#settings-strava');
    expect(uploadErrorState(err)).toEqual({
      phase: 'error',
      errorMessage: 'Strava credentials are not configured.',
      errorKind: 'creds_missing',
      actionUrl: '#settings-strava',
    });
  });

  it('maps insufficient_scope without an actionUrl', () => {
    const s = uploadErrorState(new StravaError('Missing activity:write', 'insufficient_scope'));
    expect(s.errorKind).toBe('insufficient_scope');
    expect(s.actionUrl).toBeUndefined();
  });

  it('maps a plain Error and a non-error to unknown', () => {
    expect(uploadErrorState(new Error('boom'))).toEqual({ phase: 'error', errorMessage: 'boom', errorKind: 'unknown' });
    expect(uploadErrorState('nope')).toEqual({
      phase: 'error',
      errorMessage: 'Upload failed — check console.',
      errorKind: 'unknown',
    });
  });
});

describe('shouldAutoUpload', () => {
  const base: AutoUploadInput = {
    rideState: 'finished',
    autoUploadStrava: true,
    credsPresent: true,
    sampleCount: 10,
    startedAt: 1_000,
    alreadyAutoUploaded: false,
    alreadyUploaded: () => false,
  };

  it('fires for a finished, opted-in, connected ride with samples', () => {
    expect(shouldAutoUpload(base)).toBe(true);
  });

  it.each<[string, Partial<AutoUploadInput>]>([
    ['still running', { rideState: 'running' }],
    ['auto-upload off', { autoUploadStrava: false }],
    ['Strava not configured', { credsPresent: false }],
    ['no samples', { sampleCount: 0 }],
    ['no start time', { startedAt: null }],
    ['already auto-uploaded this mount', { alreadyAutoUploaded: true }],
    ['ride already in the cache', { alreadyUploaded: (k) => k === '1000' }],
  ])('does not fire when %s', (_why, patch) => {
    expect(shouldAutoUpload({ ...base, ...patch })).toBe(false);
  });
});

describe('runStravaUpload', () => {
  const samples = [{ t: 0 }, { t: 1 }] as unknown as TelemetrySample[];
  const ride = { startedAt: 1793547000000, samples, routeName: 'Tiber river park' };

  function deps(upload: StravaUploadDeps['upload']) {
    return {
      build: vi.fn(() => new Blob(['fit'])),
      upload: vi.fn(upload),
      markUploaded: vi.fn(),
    } satisfies StravaUploadDeps;
  }

  it('reports progress, names the activity, and marks the ride on success', async () => {
    const states: UploadState[] = [];
    const d = deps(async (_blob, _meta, onState) => {
      onState?.({ phase: 'uploading' });
      onState?.({ phase: 'polling' });
      onState?.({ phase: 'success', activityId: 42 });
      return { id: 7 } as Awaited<ReturnType<StravaUploadDeps['upload']>>;
    });
    await runStravaUpload(ride, (s) => states.push(s), d);
    expect(d.build).toHaveBeenCalledWith({ startTime: ride.startedAt, samples });
    expect(d.upload.mock.calls[0][1]).toEqual({
      name: 'Tiber river park — GlobeRide',
      description: 'Uploaded via GlobeRide',
      trainer: true,
    });
    expect(states.map((s) => s.phase)).toEqual(['uploading', 'polling', 'success']);
    expect(d.markUploaded).toHaveBeenCalledWith('1793547000000');
  });

  it('does not mark the ride when Strava returns no upload id', async () => {
    const d = deps(async () => ({}) as Awaited<ReturnType<StravaUploadDeps['upload']>>);
    await runStravaUpload(ride, () => {}, d);
    expect(d.markUploaded).not.toHaveBeenCalled();
  });

  it('turns a thrown StravaError into an error state and does not mark', async () => {
    const states: UploadState[] = [];
    const d = deps(async () => {
      throw new StravaError('Token refresh failed', 'refresh_failed', 401, '', '#settings-strava');
    });
    await runStravaUpload(ride, (s) => states.push(s), d);
    expect(states.at(-1)).toEqual({
      phase: 'error',
      errorMessage: 'Token refresh failed',
      errorKind: 'refresh_failed',
      actionUrl: '#settings-strava',
    });
    expect(d.markUploaded).not.toHaveBeenCalled();
  });
});

describe('names', () => {
  it('builds a filesystem-safe FIT file name', () => {
    expect(fitFileName('Tiber river park', Date.UTC(2026, 10, 1, 15, 30, 5))).toBe(
      'Tiber_river_park_2026-11-01T15-30-05.fit',
    );
    expect(fitFileName(undefined, Date.UTC(2026, 10, 1))).toBe('globeride_2026-11-01T00-00-00.fit');
  });

  it('falls back to a dated activity name without a route', () => {
    expect(stravaActivityName(undefined, Date.UTC(2026, 10, 1))).toMatch(/^GlobeRide — /);
  });
});
