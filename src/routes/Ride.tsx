import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

import { RideView } from '@/components/ride/RideView';
import type { WorldRenderer } from '@/lib/world/renderer';
import { holdStart, START_HOLD_POLL_MS } from '@/lib/ride/startHold';
import { worldForRoute } from '@/lib/world/catalog';
import { NoTokenBanner } from '@/components/ride/NoTokenBanner';
import { PlayPanel } from '@/components/velo/PlayMode';
import { RideHud } from '@/components/velo/RideHud';
import { GestureLegend } from '@/components/ride/GestureLegend';
import { ShowCorner, ShowPanel } from '@/components/velo/ShowPanel';
import { ShowHud } from '@/components/velo/ShowHud';
import { RideFloatingNotice, ShowSurface, useRidePipWindow } from '@/components/velo/ShowSurface';
import { closeRidePip } from '@/lib/show/pip';
import { retainShowForRide, useShowStore } from '@/stores/showStore';
import { useIdle } from '@/hooks/useIdle';
import { cn } from '@/lib/utils';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRideHudStore } from '@/stores/rideHudStore';
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
import { retainRideSession } from '@/lib/controllers/rideSession';
import { reconnectGrantedController } from '@/lib/controllers/rideController';
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
 * HUD (compact ride HUD, owner-directed revision 2 Nov 2026,
 * docs/design/mockups/v2-ride-hud.html): RideHud is one bottom column —
 * collapsed ride details, the status chip and the ride band. Show mode
 * swaps it for the video panel and the show strip (v2-show.html).
 * Translucent HUD surfaces without blur: `hud-flat` keeps every
 * backdrop-filter off the live canvas.
 *
 * Also mounted:
 *   - Handlebar gesture detection on the main ride container (double-tap,
 *     long-press, two-finger swipe) — gated by settings.gestureControlsEnabled.
 *   - GestureLegend overlay, opened from the ride options menu ("Gesture
 *     help"); no floating "?" chip.
 */
export function Ride() {
  const navigate      = useNavigate();
  const location      = useLocation();
  const route         = useRideStore((s) => s.route);
  const rideState     = useRideStore((s) => s.rideState);
  const activeWorkout = useRideStore((s) => s.activeWorkout);
  const rideMode      = useRideStore((s) => s.rideMode);
  const preferredRenderer = useSettingsStore((s) => s.renderer);
  // Ride details or the devices sheet open: the no-token banner steps aside.
  const hudDetailsOpen = useRideHudStore((s) => s.expanded || s.devicesOpen);

  const gestureControlsEnabled = useSettingsStore((s) => s.gestureControlsEnabled);
  const controllerDebugVisible = useControllerDebugVisible();

  // The ride session: devices may act on their own (reconnect, wake, gear
  // buzz) only while it is open. The trainer and handlebar controls paired in
  // an earlier session reconnect on their own (no chooser).
  useEffect(() => {
    const release = retainRideSession();
    void reconnectGrantedTrainer({ silent: true });
    void reconnectGrantedController({ silent: true });
    return release;
  }, []);

  // ---- Show mode ----
  // Watch your own videos over the live ride. The HUD shrinks to one strip,
  // the camera directs itself, and everything but the video fades after a
  // few seconds without input. Ride recording is untouched.
  const showActive = useShowStore((s) => s.active);
  const showSource = useShowStore((s) => s.source);
  const dimmed = useIdle(showActive && showSource !== 'none' && rideState === 'running');
  const dimClass = cn('transition-opacity duration-300', dimmed && 'opacity-20');

  // ---- Journey mode: the ride floating over other tabs ----
  // While the picture-in-picture window is open the world draws there (one
  // WebGL context at a time) and the tab shows a notice. The window closes
  // with show mode, at the finish, and when the ride view goes.
  const floatingWindow = useRidePipWindow();
  const floating = floatingWindow !== null;
  useEffect(() => {
    if (!showActive || rideState === 'finished') closeRidePip();
  }, [showActive, rideState]);
  useEffect(() => () => closeRidePip(), []);

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
  //
  // The start also holds until the renderer draws the ground under the rider
  // at full detail (lib/ride/startHold): on Cesium's first coarse tiles the
  // rider rode tens of metres off the ground, under it at times.
  const autoStartConsumedRef = useRef(false);
  const startHeldSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (autoStartConsumedRef.current) return;
    const wantsAutoStart = (location.state as { autoStart?: boolean } | null)?.autoStart === true;
    if (!wantsAutoStart) return;
    if (!worldRenderer) return;
    if (!route && rideMode !== 'outdoor') return;
    if (rideState === 'running' || rideState === 'paused' || rideState === 'finished') return;
    startHeldSinceRef.current ??= Date.now();
    const heldSince = startHeldSinceRef.current;
    // Brief delay so the user sees the route + chase angle for a beat
    // before the workout starts ticking — feels less jarring than 0ms.
    let t: ReturnType<typeof setTimeout>;
    const tryStart = () => {
      if (holdStart(worldRenderer, Date.now() - heldSince)) {
        t = setTimeout(tryStart, START_HOLD_POLL_MS);
        return;
      }
      autoStartConsumedRef.current = true;
      const st = useRideStore.getState();
      // Re-set the route so rideState transitions ready (setRoute handles
      // this idempotently — same route ref still resets to 'ready').
      if (st.route && st.rideState !== 'ready' && st.rideState !== 'running') {
        st.setRoute(st.route);
      }
      useRideStore.getState().start();
    };
    t = setTimeout(tryStart, 600);
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

  // The compact HUD shows while riding; show mode swaps it for the video
  // panel + show strip; the finish page replaces both.
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
      {!floating && <RideView ionToken={token} onRendererReady={setWorldRenderer} />}
      <ShowSurface ionToken={token} onRendererReady={setWorldRenderer} />
      {/* With a video of the rider's own playing, the tab keeps the video panel. */}
      {floating && showSource !== 'files' && <RideFloatingNotice />}

      {/* No-token banner — subtle nudge offering the photoreal upgrade.
          Invisible when a token is already installed; dismissible per-session
          so it never gets in the way of the ride. */}
      {/* Hidden in show mode: it would sit on the show strip. */}
      {/* Hidden on world-renderer rides too: they need no token, so the
          photoreal pitch and the Bing watchdog don't apply there. */}
      {!showActive && !worldRide && !hudDetailsOpen && (
        <NoTokenBanner hasToken={token !== null && token.length > 0} />
      )}

      {/* Paused veil: a light scrim, no blur (no backdrop-filter may sit over
          the live canvas: it cost 10–25 fps, PR #16). */}
      {rideState === 'paused' && (
        <div
          className="absolute inset-0 z-10 bg-scrim/20 pointer-events-none transition-opacity duration-300"
          aria-hidden="true"
        />
      )}

      {/* -- Compact ride HUD: everything in one bottom column -------------- */}
      {/* Owner-directed revision (2 Nov 2026): one band with the figures,
          Pause / Finish and one details toggle; route card, map and ride
          tools collapsed above it; one status chip for every device or
          error state. Hidden in show mode (the show strip owns the bottom)
          and after the finish. */}
      {rideHudOn && (
        <RideHud
          onExit={() => navigate('/app')}
          onInvite={() => setInviteOpen((o) => !o)}
          onShortcuts={() => setHelpOpen((o) => !o)}
          voice={{ isListening, onToggle: isListening ? stopListening : startListening }}
          xr={xrButtons}
          modes={
            <>
              <PlayPanel compact />
              {activeWorkout && <WorkoutHUD />}
              {/* Strava Live Segments HUD */}
              <SegmentHUD />
            </>
          }
        />
      )}

      {/* -- Debug readouts (opt-in: ?perf=1, controller debug) -- top right -- */}
      {rideHudOn && (
        <div className="absolute hud-inset-t hud-inset-r z-20 flex max-w-sm flex-col items-end gap-2 pointer-events-none">
          {controllerDebugVisible && (
            <>
              <ControllerChip />
              <ControllerDebugOverlay />
            </>
          )}
          <PerfOverlay />
        </div>
      )}

      {/* -- Show mode: video panel, corner (camera + close), show strip ---- */}
      {/* ShowHud = the show strip plus the status chip, which speaks up only
          for a problem or a notice and hosts the toasts: no toast card over
          the video either. */}
      {showActive && rideState !== 'finished' && (
        <>
          <ShowPanel dimmed={dimmed} />
          <ShowCorner className={dimClass} />
          <ShowHud dimmed={dimmed} />
        </>
      )}

      {/* -- Gesture legend overlay ------------------------------- */}
      {/* Opened from Settings > Gesture help (OPEN_GESTURE_LEGEND_EVENT).
          The wrapper spans the screen, so it stays click-through: only the
          open legend takes pointer events. */}
      {gestureControlsEnabled && rideHudOn && (
        <div className="absolute inset-0 pointer-events-none z-30">
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
