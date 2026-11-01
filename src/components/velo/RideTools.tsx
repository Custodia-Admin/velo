/**
 * v2 ride tools (top-right of the ride HUD, docs/design/mockups/v2-ride-hud.html):
 * the status chip ("KICKR CORE · hills 35 %"), Show, Camera, Settings, and
 * one "More" button for the legacy ride tools the mockup left out (theme,
 * sound, ghosts, invite, shortcuts, voice, VR/AR). "More" is a deliberate
 * addition to the mockup so nothing the rider had before goes missing.
 *
 * Below sm the chip shows only when something is wrong, and Camera and
 * Settings move into "More".
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, Ellipsis, Ghost, Keyboard, Map as MapIcon, Mic, Moon, Settings, UserPlus, Volume2 } from 'lucide-react';
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
import { ShowToggle } from './ShowToggle';
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
      <RideSettingsButton className="hidden sm:inline-flex" />
      <MoreMenu
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

/** Settings as a HUD icon; also opens on the app-wide 'globeride:open-settings' event. */
export function RideSettingsButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Parameters<typeof SettingsPanel>[0]['initialTab']>('rider');

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: typeof tab }>).detail;
      setTab(detail?.tab ?? 'rider');
      setOpen(true);
    };
    window.addEventListener('globeride:open-settings', onOpen);
    return () => window.removeEventListener('globeride:open-settings', onOpen);
  }, []);

  return (
    <>
      <Button
        variant="hud"
        size="icon"
        className={className}
        aria-label="Ride settings"
        onClick={() => {
          setTab('rider');
          setOpen(true);
        }}
      >
        <Settings className="h-5 w-5" aria-hidden="true" />
      </Button>
      <SettingsPanel open={open} onClose={() => setOpen(false)} initialTab={tab} />
    </>
  );
}

// ---------------------------------------------------------------------------
// More: the legacy tools, one tap away
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

function MoreMenu({ mapOpen, onToggleMap, onInvite, onShortcuts, voice, xr }: RideToolsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const isDark = useThemeStore((s) => s.theme === 'dark');
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const sound = useAudioStore((s) => s.enabled);
  const toggleSound = useAudioStore((s) => s.toggleEnabled);
  const ghosts = useGhostStore((s) => s.ghostsEnabled);
  const ghostCount = useGhostStore((s) => s.ghostCount);
  const setGhosts = useGhostStore((s) => s.setGhostsEnabled);
  const voiceEnabled = useSettingsStore((s) => s.voiceControlEnabled);
  const cameraMode = useSettingsStore((s) => s.cameraMode);
  const setCameraMode = useSettingsStore((s) => s.setCameraMode);

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
        aria-label="More ride options"
        aria-expanded={open}
        aria-controls="ride-more-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <Ellipsis className="h-5 w-5" aria-hidden="true" />
      </Button>
      {open && (
        <div
          id="ride-more-menu"
          role="group"
          aria-label="More ride options"
          className={cn(HUD_PANEL, 'absolute right-0 top-full z-40 mt-2 flex w-64 flex-col gap-1 p-2')}
        >
          <MenuItem
            className="sm:hidden"
            icon={<Camera className={ICON} aria-hidden="true" />}
            label="Camera"
            state={CAMERA_LABELS[cameraMode]}
            onClick={() => setCameraMode(nextCameraMode(cameraMode))}
          />
          <MenuItem
            className="sm:hidden"
            icon={<Settings className={ICON} aria-hidden="true" />}
            label="Settings"
            onClick={then(() => window.dispatchEvent(new CustomEvent('globeride:open-settings')))}
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
          {xr && <div className="flex flex-wrap gap-2 px-1 pt-1 empty:hidden">{xr}</div>}
        </div>
      )}
    </div>
  );
}
