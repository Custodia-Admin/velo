import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft, Users } from 'lucide-react';

import { RideView } from '@/components/ride/RideView';
import type { WorldRenderer } from '@/lib/world/renderer';
import { NoTokenBanner } from '@/components/ride/NoTokenBanner';
import { RideHUD } from '@/components/ride/RideHUD';
import { RideControls } from '@/components/ride/RideControls';
import { Minimap } from '@/components/ride/Minimap';
import { ElevationProfile } from '@/components/ride/ElevationProfile';
import { ThemeToggle } from '@/components/setup/ThemeToggle';
import { SoundToggle } from '@/components/ride/SoundToggle';
import { GhostToggle } from '@/components/ride/GhostToggle';
import { PlayPanel } from '@/components/velo/PlayMode';
import { MobileDetailDock } from '@/components/velo/MobileDetailDock';
import { ConnectionStatus } from '@/components/ride/ConnectionStatus';
import { SensorStatusPills } from '@/components/trainer/SensorConnect';
import { ReplayBadge } from '@/components/ride/ReplayBadge';
import { SettingsButton } from '@/components/profile/SettingsPanel';
import { GestureLegend } from '@/components/ride/GestureLegend';
import { CameraSwitcher } from '@/components/ride/CameraSwitcher';
import { Button } from '@/components/ui/button';
import { ShowPanel } from '@/components/velo/ShowPanel';
import { ShowRideStrip } from '@/components/velo/ShowRideStrip';
import { ShowToggle } from '@/components/velo/ShowToggle';
import { retainShowForRide, useShowStore } from '@/stores/showStore';
import { useIdle } from '@/hooks/useIdle';
import { cn } from '@/lib/utils';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
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
import { FinishCard } from '@/components/ride/FinishCard';
import { useCompanionReceiver } from '@/hooks/useCompanionReceiver';
import { useGeolocationWatch } from '@/hooks/useGeolocationWatch';
import { useRaceRecorder } from '@/hooks/useRaceRecorder';
import { cancelSpeech } from '@/lib/speechSynthesis';
import { useVoiceControl } from '@/hooks/useVoiceControl';
import { VoiceControlButton } from '@/components/ride/VoiceControlButton';
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
 * HUD overlays mounted:
 *   - Handlebar gesture detection on the main ride container (double-tap,
 *     long-press, two-finger swipe) — gated by settings.gestureControlsEnabled.
 *   - GestureLegend overlay (the "?" chip in the top-right corner of the
 *     ride canvas).
 *   - CameraSwitcher overlay (top-right, below gesture legend) — always shown.
 */
export function Ride() {
  const navigate      = useNavigate();
  const location      = useLocation();
  const route         = useRideStore((s) => s.route);
  const rideState     = useRideStore((s) => s.rideState);
  const replayData    = useRideStore((s) => s.replayData);
  const activeWorkout = useRideStore((s) => s.activeWorkout);
  const rideMode      = useRideStore((s) => s.rideMode);

  const gestureControlsEnabled = useSettingsStore((s) => s.gestureControlsEnabled);
  const controllerDebugVisible = useControllerDebugVisible();

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

  if (!route) return null;

  return (
    <div
      ref={rideCanvasRef}
      className="fixed inset-0 w-screen h-screen overflow-hidden bg-background"
    >
      <RideView ionToken={token} onRendererReady={setWorldRenderer} />

      {/* No-token banner — subtle nudge offering the photoreal upgrade.
          Invisible when a token is already installed; dismissible per-session
          so it never gets in the way of the ride. */}
      {/* Hidden in show mode: below lg it would sit on the ride strip. */}
      {!showActive && <NoTokenBanner hasToken={token !== null && token.length > 0} />}

      {/* Paused dim veil -- subtle darkening when ride is paused */}
      {rideState === 'paused' && (
        <div
          className="absolute inset-0 bg-background/30 backdrop-blur-[2px] pointer-events-none z-[1] transition-opacity duration-300"
          aria-hidden="true"
        />
      )}

      {/* -- Top bar -------------------------------------------------------- */}
      <div
        className={cn(
          'absolute top-0 left-0 right-0 flex items-start justify-between gap-3 pointer-events-none z-[2]',
          dimClass,
        )}
        style={{
          paddingTop:   'max(env(safe-area-inset-top), 0.75rem)',
          paddingLeft:  'max(env(safe-area-inset-left), 0.75rem)',
          paddingRight: 'max(env(safe-area-inset-right), 0.75rem)',
        }}
      >
        {/* ── Left column: nav buttons + map awareness (tablet+) ── */}
        <div className="flex flex-col gap-2 items-start pointer-events-auto">
          {/* Top-bar nav row */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label="Exit ride and return to setup"
              className="rounded-pill glass glass-hairline border-transparent text-foreground hover:text-foreground"
              onClick={() => navigate('/')}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Exit
            </Button>
            <ThemeToggle />
            <SoundToggle />
            <GhostToggle />
            <Button
              variant="outline"
              size="icon"
              aria-label="Invite a friend to ride with you"
              className="rounded-full glass glass-hairline border-transparent"
              onClick={() => setInviteOpen((o) => !o)}
            >
              <Users className="h-4 w-4" aria-hidden="true" />
            </Button>
            <SettingsButton
              variant="outline"
              size="icon"
              className="rounded-full glass glass-hairline border-transparent"
            />
            <ShowToggle />
          </div>
          <ConnectionStatus compact />
          {replayData && <ReplayBadge />}
          <SensorStatusPills />
          {/* Mobile shows the chip in the HUD stack below instead. */}
          <div className="hidden sm:flex flex-col gap-2">
            <ControllerChip />
            <ControllerDebugOverlay />
            <PerfOverlay />
          </div>

          {/* Minimap — below the nav row, left column, tablet+ only */}
          {!showActive && (<>
          <div className="hidden sm:block pointer-events-none mt-1">
            <Minimap />
          </div>

          {/* Elevation profile — below minimap, left column, tablet+ only */}
          <div
            className="hidden sm:block pointer-events-auto mt-1 w-[22rem] md:w-[26rem] lg:w-[30rem] xl:w-[34rem]"
          >
            <div className="glass glass-hairline rounded-2xl p-3 sm:p-4 transition-all duration-300">
              <ElevationProfile />
            </div>
          </div>
          </>)}
        </div>

        {/* ── Right column: stats + workout HUD (tablet+) ── */}
        {/* Show mode: the ride strip sits top-right from lg, above the video. */}
        {showActive && (
          <ShowRideStrip dimmed={dimmed} className="hidden lg:flex pointer-events-auto" />
        )}
        {!showActive && <div
          className="hidden sm:flex flex-col gap-2 pointer-events-none w-full max-w-[22rem] md:max-w-[25rem] lg:max-w-[28rem] xl:max-w-[31rem] overflow-y-auto"
          style={{ maxHeight: 'calc(100vh - 6rem)' }}
        >
          <RideHUD />
          <PlayPanel />
          {activeWorkout && <WorkoutHUD />}
          {/* Strava Live Segments HUD */}
          <SegmentHUD />
        </div>}
      </div>

      {/* -- Mobile HUD -- below the top bar (single column stack) ---------- */}
      {/* Show mode: ride strip above the transport bar (and the no-token
          banner) below lg. */}
      {showActive && (
        <ShowRideStrip
          dimmed={dimmed}
          className="lg:hidden absolute left-3 right-3 bottom-40 z-[2] sm:left-1/2 sm:right-auto sm:-translate-x-1/2"
        />
      )}
      {showActive && rideState !== 'finished' && <ShowPanel dimmed={dimmed} />}

      <div
        className={cn('sm:hidden absolute left-0 right-0 pointer-events-none z-[2]', showActive && 'hidden')}
        style={{
          // Below the top bar AND the connection / Demo mode pill under it.
          top:          'calc(max(env(safe-area-inset-top), 0.75rem) + 6.5rem)',
          paddingLeft:  'max(env(safe-area-inset-left), 0.75rem)',
          paddingRight: 'max(env(safe-area-inset-right), 0.75rem)',
        }}
      >
        {/* Controller debug on: controls + raw log first, so one phone screenshot holds both. */}
        {controllerDebugVisible && (
          <div className="mb-2 flex flex-col gap-2">
            <ControllerChip />
            <ControllerDebugOverlay />
          </div>
        )}
        {/* ?perf=1: frame rate first, so one phone screenshot carries it. */}
        <PerfOverlay className="mb-2" />
        {/* Stats first on mobile */}
        <RideHUD />
        {/* Handlebar controls readout (renders nothing without Web Bluetooth) */}
        {!controllerDebugVisible && (
          <div className="mt-2 flex empty:hidden">
            <ControllerChip />
          </div>
        )}
        <PlayPanel className="mt-2" compact />
        {activeWorkout && (
          <div className="mt-2">
            <WorkoutHUD />
          </div>
        )}
        {/* Strava Live Segments HUD — mobile */}
        <div className="mt-2">
          <SegmentHUD />
        </div>
      </div>

      {/* -- Detail dock -- minimap + elevation on demand, above transport -- */}
      {/* Phones keep the scene band (horizon + rider) clear: the map and the
          elevation profile open only when the rider taps for them. Hidden in
          show mode (the ride strip owns the bottom) and after the finish. */}
      {!showActive && rideState !== 'finished' && (
        <div
          className="sm:hidden absolute left-3 right-3 z-[3] pointer-events-none"
          style={{ bottom: 'calc(max(env(safe-area-inset-bottom), 1.25rem) + 7.75rem)' }}
        >
          <MobileDetailDock />
        </div>
      )}

      {/* -- Transport controls -- bottom-center ----------------------------- */}
      {/* z-50 (above every other HUD layer) so the Start ride button can
          never be intercepted by a stray sibling. pointer-events-auto on
          the wrapper means clicks always land on the button. */}
      <div
        className={cn('absolute left-1/2 -translate-x-1/2 pointer-events-auto z-50', dimClass)}
        style={{ bottom: 'max(env(safe-area-inset-bottom), 1.25rem)' }}
      >
        <RideControls />
      </div>

      {/* -- Gesture legend "?" chip + overlay ------------------- */}
      {/* The full-screen wrapper must stay click-through: only the chip and
          its dialog take pointer events, or the top bar below is unclickable. */}
      {gestureControlsEnabled && !showActive && (
        <div className="absolute inset-0 pointer-events-none z-[4]">
          {/* GestureLegend positions itself absolutely within this container.
              The wrapper spans the screen, so it must stay click-through: only
              the chip and the open legend take pointer events. */}
          <div className="relative w-full h-full pointer-events-none">
            <GestureLegend />
          </div>
        </div>
      )}

      {/* Right-hand buttons step aside in show mode: the video panel lives
          there and the camera is directed from the panel. */}
      {!showActive && (<>
      {/* -- Camera switcher — top-right, below gesture chip ----- */}
      <div
        className="absolute pointer-events-auto z-[4]"
        style={{
          top:   'calc(max(env(safe-area-inset-top), 0.75rem) + 2.5rem)',
          right: 'max(env(safe-area-inset-right), 0.75rem)',
        }}
      >
        <CameraSwitcher />
      </div>

      {/* -- Enter VR button — top-right, below camera switcher -- */}
      {/* Invisible on non-XR browsers (EnterVRButton returns null). */}
      <div
        className="absolute pointer-events-auto z-[4]"
        style={{
          top:   'calc(max(env(safe-area-inset-top), 0.75rem) + 6.5rem)',
          right: 'max(env(safe-area-inset-right), 0.75rem)',
        }}
      >
        {cesiumViewer && (
          <Suspense fallback={null}>
            <EnterVRButton viewer={cesiumViewer} />
          </Suspense>
        )}
      </div>

      {/* -- Enter AR button — top-right, below VR button -------- */}
      {/* Invisible on non-AR browsers (EnterARButton returns null). */}
      <div
        className="absolute pointer-events-auto z-[4]"
        style={{
          top:   'calc(max(env(safe-area-inset-top), 0.75rem) + 10rem)',
          right: 'max(env(safe-area-inset-right), 0.75rem)',
        }}
      >
        {cesiumViewer && (
          <Suspense fallback={null}>
            <EnterARButton viewer={cesiumViewer} />
          </Suspense>
        )}
      </div>

      {/* -- Voice control button — top-right, below AR button -- */}
      {/* Invisible on Firefox / unsupported browsers (returns null). */}
      <div
        className="absolute pointer-events-auto z-[4]"
        style={{
          top:   'calc(max(env(safe-area-inset-top), 0.75rem) + 13.5rem)',
          right: 'max(env(safe-area-inset-right), 0.75rem)',
        }}
      >
        <VoiceControlButton
          isListening={isListening}
          onToggle={isListening ? stopListening : startListening}
        />
      </div>
      </>)}

      {/* -- VR HUD overlay — visible only during XR session ------ */}
      {cesiumViewer && (
        <Suspense fallback={null}>
          <VRHud />
        </Suspense>
      )}

      {/* -- Finish overlay ------------------------------------------------- */}
      {rideState === 'finished' && <FinishCard />}

      {/* -- Keyboard shortcuts overlay ------------------------------------- */}
      <RideShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* -- Multi-rider invite overlay ---------------------------------------- */}
      {inviteOpen && <MultiRiderInvite onClose={() => setInviteOpen(false)} />}
    </div>
  );
}
