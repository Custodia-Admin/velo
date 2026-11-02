/**
 * v2 ride tools (top-right of the ride HUD, docs/design/mockups/v2-ride-hud.html):
 * the status chip ("KICKR CORE · hills 35 %"), Show, Camera and Settings —
 * exactly the mockup's row. Settings opens the ride options menu: rider and
 * trainer settings first, then the ride tools the mockup has no button for
 * (route map, night colours, sounds, ghosts, voice, invite, shortcuts,
 * gesture help, VR/AR), so nothing the rider had before goes missing and no
 * extra button floats on the HUD.
 *
 * Below sm the chip shows only when something is wrong, and Camera moves
 * into the Settings menu.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Camera,
  Ghost,
  Hand,
  Keyboard,
  Map as MapIcon,
  Mic,
  Moon,
  Mountain,
  Settings,
  SlidersHorizontal,
  UserPlus,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsPanel } from '@/components/profile/SettingsPanel';
import { cn } from '@/lib/utils';
import type { CameraMode } from '@/lib/cesiumCameras';
import { isVoiceRecognitionSupported } from '@/lib/voice/voiceControl';
import { useAudioStore } from '@/stores/audioStore';
import { useGhostStore } from '@/stores/ghostStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';
import { OPEN_GESTURE_LEGEND_EVENT } from '@/components/ride/GestureLegend';
import { ShowToggle } from './ShowToggle';
import { toggleRideDetail } from './MobileDetailDock';
import { HUD_PANEL } from './v2';
import { statusChip } from './rideHudText';

/** Same order as the legacy CameraSwitcher. */
export const CAMERA_MODES: CameraMode[] = ['chase', 'firstPerson', 'overhead', 'sideTracking', 'cinematic', 'drone'];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'chase',
  firstPerson: 'first person',
  overhead: 'overhead',
  sideTracking: 'side',
  cinematic: 'cinematic',
  drone: 'drone',
};

export function nextCameraMode(mode: CameraMode): CameraMode {
  const at = CAMERA_MODES.indexOf(mode);
  return CAMERA_MODES[(at + 1) % CAMERA_MODES.length];
}

export interface RideToolsProps {
  mapOpen: boolean;
  onToggleMap: () => void;
  onInvite: () => void;
  onShortcuts: () => void;
  voice: { isListening: boolean; onToggle: () => void };
  /** VR / AR entry buttons (render nothing where WebXR is missing). */
  xr?: ReactNode;
}

export function RideTools({ mapOpen, onToggleMap, onInvite, onShortcuts, voice, xr }: RideToolsProps) {
  return (
    <div className="pointer-events-auto flex items-start gap-2">
      <StatusChip />
      <ShowToggle />
      <CameraButton className="hidden sm:inline-flex" />
      <RideOptionsMenu
        mapOpen={mapOpen}
        onToggleMap={onToggleMap}
        onInvite={onInvite}
        onShortcuts={onShortcuts}
        voice={voice}
        xr={xr}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function StatusChip() {
  const connection = useRideStore((s) => s.connection);
  const mode = useRideStore((s) => (s.rideMode === 'outdoor' ? 'outdoor' : s.mode));
  const deviceName = useRideStore((s) => s.deviceName);
  const erg = useRideStore((s) => s.trainerControlMode === 'erg');
  const targetPowerW = useRideStore((s) => s.targetPowerW);
  const battery = useRideStore((s) => s.batteryLevel);
  const reconnectAttempt = useRideStore((s) => s.reconnectAttempt);
  const reconnectMaxAttempts = useRideStore((s) => s.reconnectMaxAttempts);
  const replay = useRideStore((s) => s.replayData !== null);
  const difficulty = useSettingsStore((s) => s.trainerDifficulty);

  const view = statusChip({
    connection,
    mode,
    deviceName,
    difficulty,
    erg,
    targetPowerW,
    battery,
    reconnectAttempt,
    reconnectMaxAttempts,
    replay,
  });

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={view.aria}
      data-testid="ride-status-chip"
      className={cn(
        HUD_PANEL,
        'h-10 max-w-xs items-center gap-2 px-3 text-sm font-semibold',
        view.alert ? 'inline-flex' : 'hidden sm:inline-flex',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          view.tone === 'ok' && 'bg-primary',
          view.tone === 'calm' && 'bg-muted-foreground',
          view.tone === 'warn' && 'bg-destructive',
          view.pulse && 'animate-pulse',
        )}
      />
      <span aria-hidden="true" className="truncate">
        {view.label}
      </span>
    </span>
  );
}

export function CameraButton({ className }: { className?: string }) {
  const cameraMode = useSettingsStore((s) => s.cameraMode);
  const setCameraMode = useSettingsStore((s) => s.setCameraMode);
  return (
    <Button
      variant="hud"
      size="icon"
      className={className}
      aria-label={`Camera: ${CAMERA_LABELS[cameraMode]}`}
      title={`Camera: ${CAMERA_LABELS[cameraMode]}. Tap to switch.`}
      onClick={() => setCameraMode(nextCameraMode(cameraMode))}
    >
      <Camera className="h-5 w-5" aria-hidden="true" />
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Settings: the ride options menu (rider and trainer settings + the legacy
// ride tools), one tap away
// ---------------------------------------------------------------------------

function MenuItem({
  icon,
  label,
  state,
  pressed,
  onClick,
  className,
}: {
  icon: ReactNode;
  label: string;
  state?: string;
  pressed?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="quiet"
      className={cn('w-full justify-start gap-3 px-3', className)}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {state && <span className="text-sm font-normal text-muted-foreground">{state}</span>}
    </Button>
  );
}

const ICON = 'h-4 w-4 shrink-0';

/**
 * The Settings icon (mockup) opens this menu. Rider and trainer settings
 * (the full SettingsPanel) is the first item; the app-wide
 * 'globeride:open-settings' event still opens the panel directly.
 */
function RideOptionsMenu({ mapOpen, onToggleMap, onInvite, onShortcuts, voice, xr }: RideToolsProps) {
  const [open, setOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<Parameters<typeof SettingsPanel>[0]['initialTab']>('rider');
  const rootRef = useRef<HTMLDivElement>(null);

  const isDark = useThemeStore((s) => s.theme === 'dark');
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const sound = useAudioStore((s) => s.enabled);
  const toggleSound = useAudioStore((s) => s.toggleEnabled);
  const ghosts = useGhostStore((s) => s.ghostsEnabled);
  const ghostCount = useGhostStore((s) => s.ghostCount);
  const setGhosts = useGhostStore((s) => s.setGhostsEnabled);
  const voiceEnabled = useSettingsStore((s) => s.voiceControlEnabled);
  const gestures = useSettingsStore((s) => s.gestureControlsEnabled);
  const cameraMode = useSettingsStore((s) => s.cameraMode);
  const setCameraMode = useSettingsStore((s) => s.setCameraMode);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: typeof tab }>).detail;
      setTab(detail?.tab ?? 'rider');
      setOpen(false);
      setPanelOpen(true);
    };
    window.addEventListener('globeride:open-settings', onOpen);
    return () => window.removeEventListener('globeride:open-settings', onOpen);
  }, []);

  // Escape or a tap outside closes the menu. Escape stops here: on the
  // window it is the ride's pause / finish shortcut.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const then = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  const showVoice = voiceEnabled && isVoiceRecognitionSupported();

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="hud"
        size="icon"
        aria-label="Ride settings"
        aria-expanded={open}
        aria-controls="ride-options-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <Settings className="h-5 w-5" aria-hidden="true" />
      </Button>
      {open && (
        <div
          id="ride-options-menu"
          role="group"
          aria-label="Ride settings"
          className={cn(HUD_PANEL, 'absolute right-0 top-full z-40 mt-2 flex w-64 flex-col gap-1 p-2')}
        >
          <MenuItem
            icon={<SlidersHorizontal className={ICON} aria-hidden="true" />}
            label="Rider and trainer"
            onClick={then(() => {
              setTab('rider');
              setPanelOpen(true);
            })}
          />
          <MenuItem
            className="sm:hidden"
            icon={<Camera className={ICON} aria-hidden="true" />}
            label="Camera"
            state={CAMERA_LABELS[cameraMode]}
            onClick={() => setCameraMode(nextCameraMode(cameraMode))}
          />
          <MenuItem
            className="hidden sm:inline-flex"
            icon={<MapIcon className={ICON} aria-hidden="true" />}
            label="Route map"
            state={mapOpen ? 'On' : 'Off'}
            pressed={mapOpen}
            onClick={onToggleMap}
          />
          <MenuItem
            className="sm:hidden"
            icon={<MapIcon className={ICON} aria-hidden="true" />}
            label="Route map"
            onClick={then(() => toggleRideDetail('map'))}
          />
          <MenuItem
            className="sm:hidden"
            icon={<Mountain className={ICON} aria-hidden="true" />}
            label="Elevation profile"
            onClick={then(() => toggleRideDetail('profile'))}
          />
          <MenuItem
            icon={<Moon className={ICON} aria-hidden="true" />}
            label="Night colours"
            state={isDark ? 'On' : 'Off'}
            pressed={isDark}
            onClick={toggleTheme}
          />
          <MenuItem
            icon={<Volume2 className={ICON} aria-hidden="true" />}
            label="Ride sounds"
            state={sound ? 'On' : 'Off'}
            pressed={sound}
            onClick={toggleSound}
          />
          <MenuItem
            icon={<Ghost className={ICON} aria-hidden="true" />}
            label="Ghost riders"
            state={ghosts ? (ghostCount > 0 ? String(ghostCount) : 'On') : 'Off'}
            pressed={ghosts}
            onClick={() => setGhosts(!ghosts)}
          />
          {showVoice && (
            <MenuItem
              icon={<Mic className={ICON} aria-hidden="true" />}
              label="Voice control"
              state={voice.isListening ? 'Listening' : 'Off'}
              pressed={voice.isListening}
              onClick={voice.onToggle}
            />
          )}
          <MenuItem
            icon={<UserPlus className={ICON} aria-hidden="true" />}
            label="Invite a friend"
            onClick={then(onInvite)}
          />
          <MenuItem
            className="hidden sm:inline-flex"
            icon={<Keyboard className={ICON} aria-hidden="true" />}
            label="Keyboard shortcuts"
            onClick={then(onShortcuts)}
          />
          {gestures && (
            <MenuItem
              icon={<Hand className={ICON} aria-hidden="true" />}
              label="Gesture help"
              onClick={then(() => window.dispatchEvent(new Event(OPEN_GESTURE_LEGEND_EVENT)))}
            />
          )}
          {xr && <div className="flex flex-wrap gap-2 px-1 pt-1 empty:hidden">{xr}</div>}
        </div>
      )}
      <SettingsPanel open={panelOpen} onClose={() => setPanelOpen(false)} initialTab={tab} />
    </div>
  );
}
