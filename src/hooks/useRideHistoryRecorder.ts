/**
 * useRideHistoryRecorder — auto-saves a completed ride to IndexedDB.
 *
 * Watches `rideState` in the ride store. When the state transitions to
 * 'finished', saves the ride once (guarded against double-save with a ref).
 * Skips rides shorter than 30 seconds or with fewer than 1 sample.
 *
 * Mount in Ride.tsx with a single call — no props needed:
 *   useRideHistoryRecorder();
 */

import { useEffect, useRef } from 'react';
import { useRideStore } from '@/stores/rideStore';
import {
  saveRide,
  rideId,
  computeAvgPower,
  computeAvgSpeed,
  computeAscentM,
} from '@/lib/rideHistory';
import { useProfileStore } from '@/stores/profileStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRiderRosterStore } from '@/stores/riderRosterStore';
import { computeRideMetrics } from '@/lib/metrics';
import type { RideState } from '@/types';
// ADDITIVE: World Tour stage detection (static import — no async needed)
import { WORLD_TOUR_STAGES } from '@/lib/worldTourStages';

const MIN_DURATION_SEC = 30;

export function useRideHistoryRecorder(): void {
  const savedRef = useRef(false);
  const prevStateRef = useRef<RideState>('idle');

  useEffect(() => {
    // Zustand 5 subscribe takes a single listener receiving full state.
    // We track the previous rideState ourselves to detect transitions.
    const unsub = useRideStore.subscribe((state) => {
      const rideState = state.rideState;
      const prev = prevStateRef.current;
      prevStateRef.current = rideState;

      if (rideState !== 'finished') {
        // Reset the guard whenever we leave 'finished' (e.g. user clicks New Ride).
        if (savedRef.current) savedRef.current = false;
        return;
      }

      // Only act on the transition into 'finished', not on every re-render.
      if (prev === 'finished') return;

      // Already saved this finish event.
      if (savedRef.current) return;
      savedRef.current = true;

        const s = useRideStore.getState();
        const { samples, elapsedMs, route, startedAt } = s;

        // Skip trivially short rides.
        if (elapsedMs / 1000 < MIN_DURATION_SEC) return;
        if (samples.length < 1) return;

        const durationSec = Math.round(elapsedMs / 1000);
        const distanceM = samples.length > 0
          ? (samples[samples.length - 1].distance ?? 0)
          : 0;

        const name =
          route?.name ?? `Ride — ${new Date(startedAt ?? Date.now()).toLocaleDateString()}`;

        const ftpW = useSettingsStore.getState().ftpW;
        const metrics = computeRideMetrics(samples, ftpW);

        const record = {
          id: rideId(),
          name,
          startedAt: startedAt ?? Date.now() - elapsedMs,
          durationSec,
          distanceM,
          ascentM: computeAscentM(samples),
          avgPower: computeAvgPower(samples),
          avgSpeed: computeAvgSpeed(samples),
          sampleCount: samples.length,
          samples: [...samples], // snapshot so the store can be reset freely
          // Every ride is a route ride now; 'workout' / 'replay' records saved
          // by older builds stay readable (lib/rideHistory RideSource).
          source: 'route' as const,
          metrics,
          ftpW,
          riderId: useRiderRosterStore.getState().activeRiderId,
          routeRef: route ? { id: route.id, name: route.name } : undefined,
        };

        saveRide(record).catch((err) => {
          console.warn('[rideHistory] Failed to save ride:', err);
        });

        // Award XP and update lifetime stats in the profile store.
        const workoutCompleted = false;

        // ── later waves extra ride metadata ──────────────────────────────────
        // Draft seconds: accumulated via _rideDraftSec on the ride store when
        // the draft-accumulator extension is present; otherwise 0.
        const draftSec: number = (s as { _rideDraftSec?: number })._rideDraftSec ?? 0;

        // Bots: rider beat all bots when all bot distances are behind the rider.
        const paceBots = s.paceBots ?? [];
        const beatAllBots =
          paceBots.length > 0 &&
          paceBots.every((bot) => bot.state.distance < s.distance);

        // World Tour stage: synchronous check against statically-imported catalog.
        const isWorldTourStage = route
          ? WORLD_TOUR_STAGES.some((wts) => wts.route.id === route.id)
          : false;

        // Companion opened: flag set by useCompanionReceiver during this session.
        const companionOpenedThisRide: boolean =
          (s as { _companionOpenedThisRide?: boolean })._companionOpenedThisRide ?? false;

        // Mood: set by CesiumViewer/RideStore extension when available.
        const mood: string | undefined =
          (s as { _activeMood?: string })._activeMood;

        const rideInput = {
          distanceM,
          ascentM: record.ascentM,
          workoutCompleted,
          draftSec,
          beatAllBots,
          isWorldTourStage,
          companionOpenedThisRide,
          mood,
        };

        useProfileStore.getState().recordRide(rideInput);
      },
    );

    return unsub;
  }, []);
}
