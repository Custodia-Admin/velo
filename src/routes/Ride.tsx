import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

import { RideView } from '@/components/ride/RideView';
import type { WorldRenderer } from '@/lib/world/renderer';
import { worldForRoute } from '@/lib/world/catalog';
import { NoTokenBanner } from '@/components/ride/NoTokenBanner';
import { PlayPanel } from '@/components/velo/PlayMode';
import { MobileDetailDock } from '@/components/velo/MobileDetailDock';
import { RideHud } from '@/components/velo/RideHud';
import { RideStrip } from '@/components/velo/RideStrip';
import { SensorStatusPills } from '@/components/trainer/SensorConnect';
import { ReplayBadge } from '@/components/ride/ReplayBadge';
import { GestureLegend } from '@/components/ride/GestureLegend';
import { ShowCorner, ShowPanel } from '@/components/velo/ShowPanel';
import { ShowRideStrip } from '@/components/velo/ShowRideStrip';
import { retainShowForRide, useShowStore } from '@/stores/showStore';
import { useIdle } from '@/hooks/useIdle';
import { cn } from '@/lib/utils';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useControllerStore } from '@/stores/controllerStore';
import { useRideLoop } from '@/hooks/useRideLoop';
import { useReplayLoop } from '@/hooks/useReplayLoop';
import { useWorkoutEngine } from '@/hooks/useWorkoutEngine';
import { useWakeLock } from '@/hooks/useWakeLock';
import { useRideAudio } from '@/hooks/useRideAudio';
import { useRideHistoryRecorder } from '@/hooks/useRideHistoryRecorder';
import { useFtpTestSuggestion } from '@/hooks/useFtpTestSuggestion';
import { useRideKeyboardShortcuts } from '@/hooks/useRideKeyboardShortcuts';
import { useHandlebarGestures } from '@/hooks/useHandlebarGestures';
import { useRideControllerActions } from '@/hooks/useRideControllerActions';
import { ControllerChip } from '@/components/velo/ControllerChip';
import { reconnectGrantedTrainer } from '@/lib/trainerReconnect';
import { ControllerDebugOverlay, useControllerDebugVisible } from '@/components/velo/ControllerDebugOverlay';
import { PerfOverlay } from '@/components/velo/PerfOverlay';
import { WorkoutHUD } from '@/components/ride/WorkoutHUD';
import { RideShortcutsHelp } from '@/components/ride/RideShortcutsHelp';
import { FinishCard } from '@/components/velo/FinishCard';
import { useCompanionReceiver } from '@/hooks/useCompanionReceiver';
import { useGeolocationWatch } from '@/hooks/useGeolocationWatch';
import { useRaceRecorder } from '@/hooks/useRaceRecorder';
import { cancelSpeech } from '@/lib/speechSynthesis';
import { useVoiceControl } from '@/hooks/useVoiceControl';
import { useMultiriderSync } from '@/hooks/useMultiriderSync';
import { MultiRiderInvite } from '@/components/ride/MultiRiderInvite';
import { SegmentHUD } from '@/components/ride/SegmentHUD';
import { fetchSegmentsNearRoute } from '@/lib/strava/segments';
import { mapSegmentsToRoute } from '@/lib/segmentOverlay';
import { refreshAccessToken, stravaCredsPresent } from '@/lib/strava';

const TOKEN_STORAGE_KEY = 'globeride.cesiumIonToken';

// WebXR (VR/AR) drives the Cesium viewer directly, so these load only with
// the photoreal renderer (they pull in the Cesium chunk).
const EnterVRButton = lazy(() =>
  import('@/components/ride/EnterVRButton').then((m) => ({ default: m.EnterVRButton })),
);
const EnterARButton = lazy(() =>
  import('@/components/ride/EnterARButton').then((m) => ({ default: m.EnterARButton })),
);
const VRHud = lazy(() => import('@/components/ride/VRHud').then((m) => ({ default: m.VRHud })));

/**
 * Active ride view. The world renderer (RideView) full-bleed in the background; HUD + controls
 * float on top. Boots the requestAnimationFrame ride loop and a screen
 * wake lock for the duration of the run.
 *
 * A global click handler cancels any in-progress commentary speech so the
 * user can dismiss the commentator by tapping anywhere.
 *
 * HUD (v2 warm atlas, docs/design/mockups/v2-ride-hud.html): RideHud top row
 * (Exit + route panel | status chip, Show, Camera, Settings, More) and the
 * RideStrip at the bottom; show mode swaps them for the video panel and the
 * show strip (v2-show.html). Solid HUD surfaces only: `hud-flat` keeps every
 * backdrop-filter off the live canvas.
 *
 * Also mounted:
 *   - Handlebar gesture detection on the main ride container (double-tap,
 *     long-press, two-finger swipe) — gated by settings.gestureControlsEnabled.
 *   - GestureLegend overlay (the "?" chip, restyled by .ride-gesture-slot).
 */
export function Ride() {
  const navigate      = useNavigate();
  const location      = useLocation();
  const route         = useRideStore((s) => s.route);
  const rideState     = useRideStore((s) => s.rideState);
  const replayData    = useRideStore((s) => s.replayData);
  const activeWorkout = useRideStore((s) => s.activeWorkout);
  const rideMode      = useRideStore((s) => s.rideMode);
  const preferredRenderer = useSettingsStore((s) => s.renderer);

  const gestureControlsEnabled = useSettingsStore((s) => s.gestureControlsEnabled);
  const controllerDebugVisible = useControllerDebugVisible();
  // The handlebar chip shows once a unit has been paired this session.
  const handlebarsPaired = useControllerStore((s) => s.status !== 'idle');

  // A trainer paired in an earlier session reconnects on its own (no chooser).
  useEffect(() => {
    void reconnectGrantedTrainer({ silent: true });
  }, []);

  // ---- Show mode ----
  // Watch your own videos over the live ride. The HUD shrinks to one strip,
  // the camera directs itself, and everything but the video fades after a
  // few seconds without input. Ride recording is untouched.
  const showActive = useShowStore((s) => s.active);
  const showSource = useShowStore((s) => s.source);
  const dimmed = useIdle(showActive && showSource !== 'none' && rideState === 'running');
  const dimClass = cn('transition-opacity duration-300', dimmed && 'opacity-20');

  // Ref for the main ride canvas container — used by gesture detection.
  const rideCanvasRef = useRef<HTMLDivElement>(null);

  // The live world renderer (RideView hands it over once its first frame is
  // up). Auto-start waits for it; the XR buttons need the Cesium viewer,
  // which only the photoreal renderer exposes (as `native`).
  const [worldRenderer, setWorldRenderer] = useState<WorldRenderer | null>(null);
  const cesiumViewer =
    worldRenderer?.kind === 'photoreal'
      ? (worldRenderer.native as import('cesium').Viewer | undefined) ?? null
      : null;

  // ---- Outdoor GPS watcher ----
  // Always called (Rules of Hooks). Only does work when rideMode === 'outdoor'.
  // The samples ref is passed to useRideLoop so the frame loop can consume GPS.
  const { samples: gpsSamples, error: gpsError } = useGeolocationWatch();
  // We use a ref so the RAF callback always sees the latest samples array
  // without re-subscribing the effect (no stale closure risk).
  const gpsSamplesRef = useRef(gpsSamples);
  gpsSamplesRef.current = gpsSamples;

  // Run the replay loop when replay data is present; otherwise the live loop.
  // Both hooks are always called (Rules of Hooks) -- each guards on its own
  // condition internally so only one does real work at a time.
  useRideLoop(rideMode === 'outdoor' ? gpsSamplesRef : undefined);
  useReplayLoop();
  useWorkoutEngine();
  useRideHistoryRecorder();
  useRaceRecorder();
  useMultiriderSync();
  useRideAudio();
  useCompanionReceiver();  // phone companion -- ingests phone HR/cadence + handles remote control
  useFtpTestSuggestion();
  useWakeLock(rideState === 'running');

  // ---- Handlebar gestures ----
  // Always called — the hook is a no-op when gestureControlsEnabled=false.
  useHandlebarGestures(rideCanvasRef, { enabled: gestureControlsEnabled });

  // ---- Voice control ----
  // Always called (Rules of Hooks). No-op when unsupported or setting is off.
  const { isListening, startListening, stopListening } = useVoiceControl();

  const [helpOpen, setHelpOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  useRideKeyboardShortcuts({ onToggleHelp: () => setHelpOpen((o) => !o) });
  useRideControllerActions();

  // Cesium ion token resolution. The ride view no longer *requires* a token:
  // without one we fall back to OSM imagery + flat terrain (see
  // setupBaseImagery / getTerrainProvider in cesiumUtils). The banner below
  // surfaces the upgrade path without blocking the ride.
  const [token] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const fromEnv = import.meta.env.VITE_CESIUM_ION_TOKEN ?? '';
    if (fromEnv.length > 0) return fromEnv;
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  });

  useEffect(() => {
    if (!route && rideMode !== 'outdoor') navigate('/app');
  }, [route, rideMode, navigate]);

  // ---- Auto-start when arriving from the wizard ----
  // The wizard's "Start ride" CTA passes { state: { autoStart: true } } so the
  // ride begins as soon as the world is ready instead of requiring a second
  // tap on the in-ride Start button. We wait for the renderer to be set
  // (its first frame painted) before starting so the camera doesn't
  // jump from the initial flyTo to chase pose mid-transition.
  //
  // Robust gating: fire when viewer + route are present and rideState is in a
  // pre-ride state ('idle' OR 'ready'). Browser-verify showed the wizard's
  // setRoute occasionally landed before /ride's setRoute effect re-fired,
  // leaving rideState='idle' on entry — the prior `rideState !== 'ready'`
  // guard then bailed and the ride never auto-started.
  const autoStartConsumedRef = useRef(false);
  useEffect(() => {
    if (autoStartConsumedRef.current) return;
    const wantsAutoStart = (location.state as { autoStart?: boolean } | null)?.autoStart === true;
    if (!wantsAutoStart) return;
    if (!worldRenderer) return;
    if (!route && rideMode !== 'outdoor') return;
    if (rideState === 'running' || rideState === 'paused' || rideState === 'finished') return;
    autoStartConsumedRef.current = true;
    // Brief delay so the user sees the route + chase angle for a beat
    // before the workout starts ticking — feels less jarring than 0ms.
    const t = setTimeout(() => {
      const st = useRideStore.getState();
      // Re-set the route so rideState transitions ready (setRoute handles
      // this idempotently — same route ref still resets to 'ready').
      if (st.route && st.rideState !== 'ready' && st.rideState !== 'running') {
        st.setRoute(st.route);
      }
      useRideStore.getState().start();
    }, 600);
    return () => clearTimeout(t);
  }, [worldRenderer, route, rideMode, rideState, location.state]);

  // Arriving with { show: true } (Home's "Ride and watch") starts show mode;
  // leaving the ride always ends it and releases the video files.
  useEffect(() => {
    const release = retainShowForRide();
    if ((location.state as { show?: boolean } | null)?.show === true) {
      useShowStore.getState().startShow();
    }
    return release;
    // Mount/unmount only: location.state is the arrival intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Strava segment fetch ----
  // Fire once per route load, in the background. Ride continues on failure.
  useEffect(() => {
    if (!route || !stravaCredsPresent()) return;
    let cancelled = false;

    (async () => {
      try {
        const token = await refreshAccessToken();
        if (cancelled) return;

        const stravaSegs = await fetchSegmentsNearRoute(route, token);
        if (cancelled || stravaSegs.length === 0) return;

        const routeSegments = mapSegmentsToRoute(stravaSegs, route);
        if (cancelled) return;

        useRideStore.getState().setLoadedSegments(routeSegments);
      } catch {
        // Strava unavailable — segment overlay is optional; ride continues.
      }
    })();

    return () => { cancelled = true; };
  }, [route]);

  // Surface GPS errors as toasts in outdoor mode.
  useEffect(() => {
    if (rideMode !== 'outdoor' || !gpsError) return;
    const msg =
      gpsError.code === 1
        ? 'Location permission denied. Allow location access in browser settings.'
        : gpsError.code === 2
          ? 'GPS position unavailable. Check that location services are enabled.'
          : 'GPS timed out. Move outdoors or check location settings.';
    useRideStore.getState().pushToast({
      kind: 'error',
      title: 'GPS error',
      message: msg,
      durationMs: 8_000,
    });
  }, [gpsError, rideMode]);

  // Cancel commentary speech on pause or finish so the user isn't talked at
  // while stopped. The useRideLoop cleanup handles the unmount case.
  useEffect(() => {
    if (rideState === 'paused' || rideState === 'finished') {
      cancelSpeech();
    }
  }, [rideState]);

  // Global click handler: tap anywhere to dismiss in-progress speech.
  useEffect(() => {
    const handler = () => cancelSpeech();
    document.addEventListener('click', handler, { capture: true, passive: true });
    return () => document.removeEventListener('click', handler, { capture: true });
  }, []);

  // The renderer that draws (or, until its first frame, the one RideView will pick).
  const worldRide = worldRenderer
    ? worldRenderer.kind === 'world'
    : preferredRenderer === 'world' && rideMode !== 'outdoor' && worldForRoute(route) !== null;

  if (!route) return null;

  // The v2 HUD (top row + ride strip) shows while riding; show mode swaps
  // it for the video panel + show strip; the finish page replaces both.
  const rideHudOn = !showActive && rideState !== 'finished';

  // VR / AR need the Cesium viewer (photoreal only); each button renders
  // nothing on browsers without WebXR. They live in the HUD's "More" menu.
  const xrButtons = cesiumViewer ? (
    <Suspense fallback={null}>
      <EnterVRButton viewer={cesiumViewer} />
      <EnterARButton viewer={cesiumViewer} />
    </Suspense>
  ) : null;

  return (
    <div
      ref={rideCanvasRef}
      className="hud-flat ride-hud-v2 fixed inset-0 w-screen h-screen overflow-hidden bg-background"
    >
      <RideView ionToken={token} onRendererReady={setWorldRenderer} />

      {/* No-token banner — subtle nudge offering the photoreal upgrade.
          Invisible when a token is already installed; dismissible per-session
          so it never gets in the way of the ride. */}
      {/* Hidden in show mode: it would sit on the show strip. */}
      {/* Hidden on world-renderer rides too: they need no token, so the
          photoreal pitch and the Bing watchdog don't apply there. */}
      {!showActive && !worldRide && <NoTokenBanner hasToken={token !== null && token.length > 0} />}

      {/* Paused veil: a light scrim, no blur (no backdrop-filter may sit over
          the live canvas: it cost 10–25 fps, PR #16). */}
      {rideState === 'paused' && (
        <div
          className="absolute inset-0 z-10 bg-scrim/20 pointer-events-none transition-opacity duration-300"
          aria-hidden="true"
        />
      )}

      {/* -- HUD top row: Exit + route panel | tools + panels under them ---- */}
      {rideHudOn && (
        <RideHud
          onExit={() => navigate('/app')}
          onInvite={() => setInviteOpen((o) => !o)}
          onShortcuts={() => setHelpOpen((o) => !o)}
          voice={{ isListening, onToggle: isListening ? stopListening : startListening }}
          xr={xrButtons}
          side={
            <>
              {replayData && <ReplayBadge />}
              <SensorStatusPills />
              {(handlebarsPaired || controllerDebugVisible) && <ControllerChip />}
              <ControllerDebugOverlay />
              <PerfOverlay />
              <PlayPanel />
              {activeWorkout && <WorkoutHUD />}
              {/* Strava Live Segments HUD */}
              <SegmentHUD />
            </>
          }
        />
      )}

      {/* -- Mobile HUD -- below the top row (single column stack) ---------- */}
      {/* The same panels as the sm+ column under the tools, one column. */}
      {rideHudOn && (
        <div className="sm:hidden absolute hud-inset-x top-ride-stack z-20 flex flex-col gap-2 pointer-events-none">
          {/* Controller debug on: controls + raw log first, so one phone screenshot holds both. */}
          {controllerDebugVisible && (
            <>
              <ControllerChip />
              <ControllerDebugOverlay />
            </>
          )}
          {/* ?perf=1: frame rate first, so one phone screenshot carries it. */}
          <PerfOverlay />
          {/* Handlebar controls readout, once a unit has been paired. */}
          {!controllerDebugVisible && handlebarsPaired && <ControllerChip />}
          {replayData && <ReplayBadge />}
          <PlayPanel compact />
          {activeWorkout && <WorkoutHUD />}
          {/* Strava Live Segments HUD — mobile */}
          <SegmentHUD />
        </div>
      )}

      {/* -- Transport controls -- the ride strip, bottom centre ------------ */}
      {/* Phones: the strip spans the screen and the detail dock (map +
          elevation on demand) sits right above it, in the same column, so
          the two can never collide. Hidden in show mode (the show strip
          owns the bottom) and after the finish.
          sm+: w-max — an absolutely-positioned left-1/2 box shrink-fits to
          the width left of its left edge, which would wrap the strip;
          max-w-hud-strip caps it to the viewport. */}
      {rideHudOn && (
        <div className="absolute hud-inset-b hud-inset-x z-20 flex flex-col items-stretch gap-2 pointer-events-none sm:left-1/2 sm:right-auto sm:w-max sm:max-w-hud-strip sm:-translate-x-1/2">
          <MobileDetailDock className="sm:hidden" />
          <RideStrip />
        </div>
      )}

      {/* -- Show mode: video panel, corner (camera + close), show strip ---- */}
      {showActive && rideState !== 'finished' && (
        <>
          <ShowPanel dimmed={dimmed} />
          <ShowCorner className={dimClass} />
          <ShowRideStrip
            dimmed={dimmed}
            className="absolute hud-inset-b show-inset-l show-inset-r z-20 sm:left-auto"
          />
        </>
      )}

      {/* -- Gesture legend "?" chip + overlay ------------------- */}
      {/* The full-screen wrapper must stay click-through: only the chip and
          its dialog take pointer events, or the HUD below is unclickable.
          ride-gesture-slot (index.css) turns the chip into a HUD icon button
          in a free corner. */}
      {gestureControlsEnabled && rideHudOn && (
        <div className="ride-gesture-slot absolute inset-0 pointer-events-none z-30">
          {/* GestureLegend positions itself absolutely within this container.
              The wrapper spans the screen, so it must stay click-through: only
              the chip and the open legend take pointer events. */}
          <div className="relative w-full h-full pointer-events-none">
            <GestureLegend />
          </div>
        </div>
      )}

      {/* -- VR HUD overlay — visible only during XR session ------ */}
      {cesiumViewer && (
        <Suspense fallback={null}>
          <VRHud />
        </Suspense>
      )}

      {/* -- Finish page ---------------------------------------------------- */}
      {rideState === 'finished' && <FinishCard />}

      {/* -- Keyboard shortcuts overlay ------------------------------------- */}
      <RideShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* -- Multi-rider invite overlay ---------------------------------------- */}
      {inviteOpen && <MultiRiderInvite onClose={() => setInviteOpen(false)} />}
    </div>
  );
}
