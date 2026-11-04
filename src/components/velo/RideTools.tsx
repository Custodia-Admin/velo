/**
 * Ride tools (compact ride HUD, owner-directed revision 2 Nov 2026,
 * docs/design/mockups/v2-ride-hud.html): one row of HUD icon buttons at the
 * foot of the ride details — Show (ride and watch), Camera, Ghost riders,
 * Voice (where the browser can listen), Settings, and Exit below sm (from
 * sm Exit sits at the start of the ride band). Settings opens the ride
 * options menu upward: rider and trainer settings first, then night
 * colours, sounds, invite, shortcuts, gesture help and VR / AR, so nothing
 * the rider had before goes missing and no extra button floats on the HUD.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Camera,
  Ghost,
  Hand,
  Keyboard,
  Mic,
  Moon,
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
import { useSettingsStore } from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';
import { OPEN_GESTURE_LEGEND_EVENT } from '@/components/ride/GestureLegend';
import { ShowToggle } from './ShowToggle';
import { HUD_PANEL } from './v2';

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

/** Pressed HUD toggle: the ShowToggle convention (a 1px ring is invisible over glass). */
const PRESSED = 'border-primary bg-primary/15 text-primary';

export interface RideToolsProps {
  onExit: () => void;
  onInvite: () => void;
  onShortcuts: () => void;
  voice: { isListening: boolean; onToggle: () => void };
  /** VR / AR entry buttons (render nothing where WebXR is missing). */
  xr?: ReactNode;
}

export function RideTools({ onExit, onInvite, onShortcuts, voice, xr, className }: RideToolsProps & { className?: string }) {
  const ghosts = useGhostStore((s) => s.ghostsEnabled);
  const ghostCount = useGhostStore((s) => s.ghostCount);
  const setGhosts = useGhostStore((s) => s.setGhostsEnabled);
  const voiceEnabled = useSettingsStore((s) => s.voiceControlEnabled);
  const showVoice = voiceEnabled && isVoiceRecognitionSupported();

  return (
    <div className={cn('pointer-events-auto flex flex-wrap items-center gap-2', className)} role="group" aria-label="Ride tools">
      <ShowToggle />
      <CameraButton />
      <Button
        variant="hud"
        size="icon"
        aria-pressed={ghosts}
        aria-label={ghosts ? `Ghost riders on${ghostCount > 0 ? `: ${ghostCount}` : ''}` : 'Ghost riders off'}
        title="Ghost riders"
        className={cn(ghosts && PRESSED)}
        onClick={() => setGhosts(!ghosts)}
      >
        <Ghost className="h-5 w-5" aria-hidden="true" />
      </Button>
      {showVoice && (
        <Button
          variant="hud"
          size="icon"
          aria-pressed={voice.isListening}
          aria-label={voice.isListening ? 'Voice control: listening' : 'Voice control: off'}
          title="Voice control"
          className={cn(voice.isListening && PRESSED)}
          onClick={voice.onToggle}
        >
          <Mic className="h-5 w-5" aria-hidden="true" />
        </Button>
      )}
      <RideOptionsMenu onInvite={onInvite} onShortcuts={onShortcuts} xr={xr} />
      <Button
        variant="hud"
        size="icon"
        className="sm:hidden"
        aria-label="Exit ride and return to setup"
        title="Exit ride"
        onClick={onExit}
      >
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

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
 * The Settings icon opens this menu, upward from the tools row. Rider and
 * trainer settings (the full SettingsPanel) is the first item; the
 * app-wide 'globeride:open-settings' event still opens the panel directly.
 */
function RideOptionsMenu({ onInvite, onShortcuts, xr }: Pick<RideToolsProps, 'onInvite' | 'onShortcuts' | 'xr'>) {
  const [open, setOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<Parameters<typeof SettingsPanel>[0]['initialTab']>('rider');
  const rootRef = useRef<HTMLDivElement>(null);

  const isDark = useThemeStore((s) => s.theme === 'dark');
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const sound = useAudioStore((s) => s.enabled);
  const toggleSound = useAudioStore((s) => s.toggleEnabled);
  const gestures = useSettingsStore((s) => s.gestureControlsEnabled);

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

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="hud"
        size="icon"
        aria-label="Ride settings"
        aria-expanded={open}
        aria-controls="ride-options-menu"
        className={cn(open && PRESSED)}
        onClick={() => setOpen((o) => !o)}
      >
        <Settings className="h-5 w-5" aria-hidden="true" />
      </Button>
      {open && (
        <div
          id="ride-options-menu"
          role="group"
          aria-label="Ride settings"
          className={cn(
            HUD_PANEL,
            'absolute bottom-full left-0 z-40 mb-2 flex w-64 flex-col gap-1 p-2 sm:bottom-0 sm:left-full sm:mb-0 sm:ml-2',
          )}
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
