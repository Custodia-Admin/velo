/**
 * Show mode's video surface (docs/design/mockups/v2-show.html): play the
 * rider's own videos over the live ride.
 *
 * The player is a scrim panel at the top-left: the video, a thin progress
 * bar (tap to seek), and one control bar (play/pause, title, time left,
 * S/M/L size, next). The corner holds the camera choice and Close. Other
 * states: choose (nothing picked yet), a show running in picture-in-picture
 * from another tab, and errors. The 3D world keeps rendering around it and
 * ride recording is untouched. On-system per docs/design/UI-RULES.md.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Camera, ChevronDown, Film, Pause, PictureInPicture2, Play, SkipForward, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CameraMode } from '@/lib/cesiumCameras';
import { pickVideos } from '@/lib/show/pickVideos';
import {
  canUseFilePicker,
  filesFromHandles,
  formatClock,
  latestResume,
  recallHandles,
  resumePosition,
  saveResume,
  type ResumeEntry,
} from '@/lib/show/showLibrary';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShowStore, type ShowSize } from '@/stores/showStore';
import { ShowToggle } from './ShowToggle';
import { HUD_PANEL } from './v2';

/** Panel width per size from sm (L = 55 % of the screen, as in the mockup). */
const SIZE_CLASS: Record<ShowSize, string> = {
  s: 'sm:w-show-s',
  m: 'sm:w-show-m',
  l: 'sm:w-show-l',
};

const SIZE_LABEL: Record<ShowSize, string> = { s: 'Small', m: 'Medium', l: 'Large' };

/** Cameras the rider can step through after "Auto"; road-height shots left out. */
const CAMERA_CHOICES: CameraMode[] = ['chase', 'drone', 'cinematic', 'overhead'];
const CAMERA_LABEL: Partial<Record<CameraMode, string>> = {
  chase: 'Chase',
  drone: 'Drone',
  cinematic: 'Orbit',
  overhead: 'Overhead',
};

/** Top-left on every width; full width (minus the HUD insets) below sm. */
const PANEL_PLACE = 'absolute show-inset-t show-inset-l show-inset-r z-20 sm:right-auto';

/** Control-bar icon buttons: no surface of their own, light on the scrim. */
const ON_SCRIM = 'text-on-scrim hover:bg-on-scrim/15 hover:text-on-scrim';

const NOT_PLAYABLE = 'Those files are not videos Chrome can play. Try MP4 or WebM.';

export function ShowPanel({ dimmed }: { dimmed: boolean }) {
  const active = useShowStore((s) => s.active);
  const panelOpen = useShowStore((s) => s.panelOpen);
  const source = useShowStore((s) => s.source);
  const item = useShowStore((s) => s.items[s.index]);
  const size = useShowStore((s) => s.size);

  if (!active) return null;
  if (source === 'pip') return <PipBar dimmed={dimmed} />;
  if (!panelOpen) return null;

  if (!item) {
    return (
      <section aria-label="Show" data-testid="show-panel" className={cn(PANEL_PLACE, HUD_PANEL, 'sm:w-full sm:max-w-lg')}>
        <ShowChooser />
      </section>
    );
  }

  return (
    <section
      aria-label="Your video"
      data-testid="show-panel"
      className={cn(
        PANEL_PLACE,
        'flex aspect-video flex-col overflow-hidden rounded-lg bg-scrim text-on-scrim shadow-md sm:max-h-show-fit',
        SIZE_CLASS[size],
      )}
    >
      <ShowPlayer key={item.url} dimmed={dimmed} />
    </section>
  );
}

/** Top-right corner in show mode (sm+): the camera choice and Close. */
export function ShowCorner({ className }: { className?: string }) {
  const active = useShowStore((s) => s.active);
  if (!active) return null;
  return (
    <div className={cn('absolute show-inset-t show-inset-r z-20 hidden items-start gap-2 sm:flex', className)}>
      <CameraButton />
      <ShowToggle />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Choose: local files, continue last time, or picture-in-picture guidance
// ---------------------------------------------------------------------------

function useChoose(): { choose: (files?: File[]) => Promise<void>; error: string | null } {
  const loadFiles = useShowStore((s) => s.loadFiles);
  const [error, setError] = useState<string | null>(null);
  const choose = async (preset?: File[]) => {
    setError(null);
    try {
      const files = preset ?? (await pickVideos());
      if (files.length > 0) loadFiles(files);
      else if (preset) setError('Those videos are no longer on this device. Choose them again.');
    } catch {
      setError(NOT_PLAYABLE);
    }
  };
  return { choose, error };
}

function ShowChooser() {
  const endShow = useShowStore((s) => s.endShow);
  const usePip = useShowStore((s) => s.usePip);
  const setIndex = useShowStore((s) => s.setIndex);
  const { choose, error } = useChoose();
  const [resume] = useState<ResumeEntry | null>(() => latestResume());
  const [handles, setHandles] = useState<FileSystemFileHandle[]>([]);

  useEffect(() => {
    if (!resume || !canUseFilePicker()) return;
    let live = true;
    void recallHandles().then((h) => live && setHandles(h));
    return () => {
      live = false;
    };
  }, [resume]);

  const canContinue = resume !== null && handles.length > 0;

  const onContinue = async () => {
    const files = await filesFromHandles(handles);
    await choose(files);
    const { items } = useShowStore.getState();
    const at = items.findIndex((it) => it.key === resume?.key);
    if (at > 0) setIndex(at);
  };

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6" data-testid="show-chooser">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-xl font-semibold sm:text-2xl">Watch something while you ride</h2>
        <Button variant="ghost" size="icon" aria-label="Close show" onClick={endShow}>
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        Pick videos saved on this device. Choose several to play them in order. The ride keeps
        recording underneath.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {canContinue && resume && (
          <Button
            size="lg"
            variant="primary"
            className="h-auto min-h-12 whitespace-normal py-2 text-left"
            onClick={() => void onContinue()}
          >
            <Play className="h-5 w-5" aria-hidden="true" />
            Continue {resume.name} · {formatClock(resume.positionS)}
          </Button>
        )}
        <Button size="lg" variant={canContinue ? 'outline' : 'primary'} onClick={() => void choose()}>
          <Film className="h-5 w-5" aria-hidden="true" />
          Choose videos
        </Button>
      </div>
      {resume && !canContinue && (
        <p className="text-sm text-muted-foreground">
          Pick “{resume.name}” again to carry on from {formatClock(resume.positionS)}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <details className="group flex flex-col gap-3 border-t border-border pt-4">
        <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 text-base font-semibold">
          Watching in another tab?
          <ChevronDown
            className="h-5 w-5 text-muted-foreground transition-transform duration-150 group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
          <li>Start the show in another Chrome tab.</li>
          <li>Open Chrome’s media controls in the toolbar and press picture-in-picture.</li>
          <li>Come back to Velo. The show floats on top while you ride.</li>
        </ol>
        <div>
          <Button variant="outline" onClick={usePip} className="mt-3">
            <PictureInPicture2 className="h-4 w-4" aria-hidden="true" />
            Use picture-in-picture
          </Button>
        </div>
      </details>
    </div>
  );
}

function PipBar({ dimmed }: { dimmed: boolean }) {
  const endShow = useShowStore((s) => s.endShow);
  const { choose, error } = useChoose();
  return (
    <section
      aria-label="Show"
      data-testid="show-pip-bar"
      className={cn(
        PANEL_PLACE,
        HUD_PANEL,
        'flex flex-col gap-2 p-3 transition-opacity duration-300 sm:w-auto',
        dimmed && 'opacity-20',
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <PictureInPicture2 className="h-5 w-5 text-primary" aria-hidden />
        <p className="text-sm">Your show is in picture-in-picture.</p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => void choose()}>
            <Film className="h-4 w-4" aria-hidden="true" />
            Choose videos
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close show" onClick={endShow}>
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

type LoadState = 'loading' | 'ready' | 'error';

/** Progress width on a 0..1000 viewBox, so the bar needs no inline style. */
const BAR_W = 1000;

function ShowPlayer({ dimmed }: { dimmed: boolean }) {
  const items = useShowStore((s) => s.items);
  const index = useShowStore((s) => s.index);
  const playing = useShowStore((s) => s.playing);
  const setPlaying = useShowStore((s) => s.setPlaying);
  const next = useShowStore((s) => s.next);
  const endShow = useShowStore((s) => s.endShow);
  const item = items[index];

  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSavedRef = useRef(0);
  const [load, setLoad] = useState<LoadState>('loading');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const save = () => {
    const v = videoRef.current;
    if (!v || !item) return;
    saveResume({
      key: item.key,
      name: item.title,
      positionS: v.currentTime,
      durationS: Number.isFinite(v.duration) ? v.duration : 0,
    });
  };

  // Remember where we stopped when the panel closes or the ride ends.
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      if (v && item) {
        saveResume({
          key: item.key,
          name: item.title,
          positionS: v.currentTime,
          durationS: Number.isFinite(v.duration) ? v.duration : 0,
        });
      }
      setPlaying(false);
    };
  }, [item, setPlaying]);

  if (!item) return null;

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(Number.isFinite(v.duration) ? v.duration : 0);
    const at = resumePosition(item.key);
    if (at > 0 && (!Number.isFinite(v.duration) || at < v.duration - 20)) v.currentTime = at;
    v.play().catch(() => setPlaying(false));
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    // Whole seconds: the bar and the "left" clock need no finer steps.
    setTime(Math.floor(v.currentTime));
    if (Math.abs(v.currentTime - lastSavedRef.current) >= 5) {
      lastSavedRef.current = v.currentTime;
      save();
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => setPlaying(false));
    else v.pause();
  };

  const seek = (e: ReactPointerEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !(duration > 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    v.currentTime = f * duration;
    setTime(Math.floor(v.currentTime));
  };

  const hasNext = index + 1 < items.length;
  const progress = duration > 0 ? Math.min(1, time / duration) : 0;
  const controlsHidden = dimmed && 'invisible';

  return (
    <>
      <div className="relative min-h-0 flex-1 bg-scrim">
        <video
          ref={videoRef}
          src={item.url}
          className="h-full w-full object-contain"
          playsInline
          preload="metadata"
          data-testid="show-video"
          onLoadedMetadata={onLoadedMetadata}
          onCanPlay={() => setLoad('ready')}
          onError={() => setLoad('error')}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            save();
          }}
          onTimeUpdate={onTimeUpdate}
          onEnded={() => {
            save();
            if (!next()) setPlaying(false);
          }}
          onClick={() => {
            if (!dimmed) togglePlay();
          }}
        />
        {load !== 'ready' && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            {load === 'loading' ? (
              <p className="text-sm text-on-scrim/70">Opening {item.title}…</p>
            ) : (
              <p role="alert" className="max-w-prose text-sm font-medium text-on-scrim">
                {item.title} can’t play in Chrome. Try an MP4 or WebM copy.
              </p>
            )}
          </div>
        )}
      </div>

      <div
        className={cn('h-1 shrink-0 cursor-pointer bg-on-scrim/25', controlsHidden)}
        aria-hidden="true"
        data-testid="show-progress"
        onPointerDown={seek}
      >
        <svg className="block h-full w-full text-primary" viewBox={`0 0 ${BAR_W} 4`} preserveAspectRatio="none">
          <rect width={Math.round(progress * BAR_W)} height="4" fill="currentColor" />
        </svg>
      </div>

      <div
        className={cn('flex shrink-0 items-center gap-3 bg-scrim/90 px-3 py-2', controlsHidden)}
        data-testid="show-controls"
      >
        <Button
          variant="ghost"
          size="icon"
          className={ON_SCRIM}
          aria-label={playing ? 'Pause video' : 'Play video'}
          onClick={togglePlay}
        >
          {playing ? <Pause className="h-5 w-5" aria-hidden="true" /> : <Play className="h-5 w-5" aria-hidden="true" />}
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="show-title" title={item.title}>
          {item.title}
          {items.length > 1 && (
            <span className="num font-normal text-on-scrim/70">
              {' '}
              · {index + 1} of {items.length}
            </span>
          )}
        </p>
        {duration > 0 && (
          <span className="num shrink-0 text-sm">{formatClock(Math.max(0, duration - time))} left</span>
        )}
        <SizePicker />
        <Button
          variant="ghost"
          size="icon"
          className={ON_SCRIM}
          aria-label="Next video"
          disabled={!hasNext}
          onClick={() => next()}
        >
          <SkipForward className="h-5 w-5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(ON_SCRIM, 'sm:hidden')}
          aria-label="Close show mode"
          onClick={endShow}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>
    </>
  );
}

function CameraButton() {
  const autoCamera = useShowStore((s) => s.autoCamera);
  const setAutoCamera = useShowStore((s) => s.setAutoCamera);
  const cameraMode = useSettingsStore((s) => s.cameraMode);
  const setCameraMode = useSettingsStore((s) => s.setCameraMode);
  const label = autoCamera ? 'Auto' : CAMERA_LABEL[cameraMode] ?? 'Chase';

  const onClick = () => {
    if (autoCamera) {
      setAutoCamera(false);
      setCameraMode('chase');
      return;
    }
    const at = CAMERA_CHOICES.indexOf(cameraMode);
    if (at < 0 || at === CAMERA_CHOICES.length - 1) setAutoCamera(true);
    else setCameraMode(CAMERA_CHOICES[at + 1]);
  };

  return (
    <Button variant="hud" onClick={onClick} aria-label={`Camera: ${label}. Switch camera`} data-testid="show-camera">
      <Camera className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

function SizePicker() {
  const size = useShowStore((s) => s.size);
  const setSize = useShowStore((s) => s.setSize);
  return (
    <div role="radiogroup" aria-label="Video size" className="hidden shrink-0 gap-1 sm:flex">
      {(['s', 'm', 'l'] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={size === s}
          aria-label={SIZE_LABEL[s]}
          onClick={() => setSize(s)}
          className={cn(
            'h-10 w-10 rounded-md text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            size === s ? 'bg-on-scrim/15' : 'hover:bg-on-scrim/10',
          )}
        >
          {s.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
