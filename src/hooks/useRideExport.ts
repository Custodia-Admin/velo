/**
 * useRideExport — the finished ride's ways out: a .FIT download and the
 * Strava upload state machine (uploading → polling → success | error).
 *
 * Shared by the v2 finish page (src/components/velo/FinishCard.tsx) and the
 * legacy RideControls bar. Auto-upload on finish is opt-in (`autoUpload`)
 * so exactly one mounted consumer owns it: two consumers each with their own
 * in-session guard would both upload the same ride.
 *
 * Idempotency: a localStorage list of uploaded ride keys (the ride's
 * startedAt), capped at the 20 most recent, survives unmount/remount and
 * page reloads; an in-session ref stops a second auto-upload in one mount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildFit, downloadFit as saveFitFile } from '@/lib/fitExporter';
import {
  clearCachedToken,
  stravaCredsPresent,
  StravaError,
  uploadFit,
  type UploadState,
} from '@/lib/strava';
import { forceReauth } from '@/lib/stravaOauth';
import type { TelemetrySample } from '@/types';

export const UPLOADED_CACHE_KEY = 'globeride.strava.uploaded.v1';
export const UPLOADED_CACHE_CAP = 20;

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): KeyStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readCache(store: KeyStore): string[] {
  const raw = store.getItem(UPLOADED_CACHE_KEY);
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

/** True when this ride key is already in the uploaded-ride cache. */
export function isRideAlreadyUploaded(rideKey: string, store: KeyStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    return readCache(store).includes(rideKey);
  } catch {
    return false;
  }
}

/** Add a ride key to the cache, keeping only the most recent 20. */
export function markRideAsUploaded(rideKey: string, store: KeyStore | null = defaultStore()): void {
  if (!store) return;
  try {
    const cache = readCache(store);
    if (cache.includes(rideKey)) return;
    cache.push(rideKey);
    if (cache.length > UPLOADED_CACHE_CAP) cache.splice(0, cache.length - UPLOADED_CACHE_CAP);
    store.setItem(UPLOADED_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage unavailable: the in-session ref still guards.
  }
}

/** The ride's cache key: its start time. */
export function rideKey(startedAt: number): string {
  return String(startedAt);
}

/** `<route>_<ISO time>.fit`, filesystem-safe. */
export function fitFileName(routeName: string | undefined, startedAt: number): string {
  const safe = (routeName ?? 'globeride').replace(/[^a-z0-9-_]+/gi, '_');
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${safe}_${stamp}.fit`;
}

/** Strava activity title. */
export function stravaActivityName(routeName: string | undefined, startedAt: number): string {
  return routeName
    ? `${routeName} — GlobeRide`
    : `GlobeRide — ${new Date(startedAt).toLocaleDateString()}`;
}

/** Map anything thrown by the upload to the error state the UI renders. */
export function uploadErrorState(err: unknown): UploadState {
  if (err instanceof StravaError) {
    return {
      phase: 'error',
      errorMessage: err.message,
      errorKind: err.kind,
      actionUrl: err.actionUrl,
    };
  }
  return {
    phase: 'error',
    errorMessage: err instanceof Error ? err.message : 'Upload failed — check console.',
    errorKind: 'unknown',
  };
}

export interface AutoUploadInput {
  rideState: string;
  autoUploadStrava: boolean;
  credsPresent: boolean;
  sampleCount: number;
  startedAt: number | null;
  alreadyAutoUploaded: boolean;
  alreadyUploaded: (key: string) => boolean;
}

/** The auto-upload gate: finished, opted in, connected, has data, not done yet. */
export function shouldAutoUpload(i: AutoUploadInput): boolean {
  return (
    i.rideState === 'finished' &&
    i.autoUploadStrava &&
    i.credsPresent &&
    i.sampleCount > 0 &&
    !!i.startedAt &&
    !i.alreadyAutoUploaded &&
    !i.alreadyUploaded(rideKey(i.startedAt))
  );
}

export interface StravaUploadDeps {
  build: typeof buildFit;
  upload: typeof uploadFit;
  markUploaded: (key: string) => void;
}

const DEFAULT_DEPS: StravaUploadDeps = {
  build: buildFit,
  upload: uploadFit,
  markUploaded: (key) => markRideAsUploaded(key),
};

/**
 * One upload: build the FIT, upload it reporting every state, mark the ride
 * uploaded on success, and turn any failure into an error state.
 */
export async function runStravaUpload(
  ride: { startedAt: number; samples: TelemetrySample[]; routeName?: string },
  onState: (s: UploadState) => void,
  deps: StravaUploadDeps = DEFAULT_DEPS,
): Promise<void> {
  const blob = deps.build({ startTime: ride.startedAt, samples: ride.samples });
  try {
    const result = await deps.upload(
      blob,
      { name: stravaActivityName(ride.routeName, ride.startedAt), description: 'Uploaded via GlobeRide', trainer: true },
      onState,
    );
    // Persist the uploaded key so remounts don't re-trigger auto-upload.
    if (result.id) deps.markUploaded(rideKey(ride.startedAt));
  } catch (err) {
    onState(uploadErrorState(err));
  }
}

export interface UseRideExportOptions {
  /** Upload once on finish when the rider turned Strava auto-upload on. */
  autoUpload?: boolean;
}

export interface RideExport {
  /** A ride with samples to export. */
  canExport: boolean;
  downloadFit: () => void;
  /** Strava client credentials + a refresh token are present. */
  stravaConfigured: boolean;
  uploadState: UploadState;
  isUploading: boolean;
  uploadToStrava: () => Promise<void>;
  resetUpload: () => void;
  /** insufficient_scope fix: clear the tokens and re-authorize in this tab. */
  reauthorizeStrava: () => void;
}

export function useRideExport({ autoUpload = false }: UseRideExportOptions = {}): RideExport {
  const rideState = useRideStore((s) => s.rideState);
  const samples = useRideStore((s) => s.samples);
  const startedAt = useRideStore((s) => s.startedAt);
  const routeName = useRideStore((s) => s.route?.name);
  const autoUploadStrava = useSettingsStore((s) => s.autoUploadStrava);

  const [uploadState, setUploadState] = useState<UploadState>({ phase: 'idle' });
  const hasAutoUploadedRef = useRef(false);
  const isUploading = uploadState.phase === 'uploading' || uploadState.phase === 'polling';

  const downloadFit = useCallback(() => {
    if (!startedAt || samples.length === 0) return;
    saveFitFile(buildFit({ startTime: startedAt, samples }), fitFileName(routeName, startedAt));
  }, [startedAt, samples, routeName]);

  const uploadToStrava = useCallback(async () => {
    if (!startedAt || samples.length === 0) return;
    if (isUploading) return;
    await runStravaUpload({ startedAt, samples, routeName }, setUploadState);
  }, [startedAt, samples, routeName, isUploading]);

  useEffect(() => {
    if (!autoUpload) return;
    if (
      shouldAutoUpload({
        rideState,
        autoUploadStrava,
        credsPresent: stravaCredsPresent(),
        sampleCount: samples.length,
        startedAt,
        alreadyAutoUploaded: hasAutoUploadedRef.current,
        alreadyUploaded: (key) => isRideAlreadyUploaded(key),
      })
    ) {
      hasAutoUploadedRef.current = true;
      void uploadToStrava();
    }
  }, [autoUpload, rideState, autoUploadStrava, samples.length, startedAt, uploadToStrava]);

  const resetUpload = useCallback(() => setUploadState({ phase: 'idle' }), []);
  const reauthorizeStrava = useCallback(() => forceReauth(clearCachedToken), []);

  return {
    canExport: !!startedAt && samples.length > 0,
    downloadFit,
    stravaConfigured: stravaCredsPresent(),
    uploadState,
    isUploading,
    uploadToStrava,
    resetUpload,
    reauthorizeStrava,
  };
}
