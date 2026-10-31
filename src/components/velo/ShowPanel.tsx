/**
 * Show mode's video surface: play the rider's own videos over the live ride.
 *
 * States: choose (nothing picked yet), playing local files, a show running in
 * picture-in-picture from another tab, and errors. The 3D world keeps
 * rendering around it and ride recording is untouched. On-system per
 * docs/design/UI-RULES.md.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  ChevronDown,
  Film,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  X,
} from 'lucide-react';
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

const SIZE_CLASS: Record<ShowSize, string> = {
  s: 'sm:w-1/2 lg:w-1/3',
  m: 'sm:w-2/3 lg:w-1/2',
  l: 'sm:w-11/12 lg:w-2/3',
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

const PANEL_FRAME =
  'glass glass-hairline absolute left-3 right-3 top-16 z-10 flex flex-col overflow-hidden rounded-lg sm:left-auto sm:right-3 sm:top-24 sm:max-w-show-fit';

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

  return (
    <section
      aria-label="Show"
      data-testid="show-panel"
      className={cn(PANEL_FRAME, SIZE_CLASS[size])}
    >
      {item ? <ShowPlayer key={item.url} dimmed={dimmed} /> : <ShowChooser />}
    </section>
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
        <h2 className="text-xl font-bold text-foreground sm:text-2xl">Watch something while you ride</h2>
        <Button variant="ghost" size="icon" aria-label="Close show" onClick={endShow}>
          <X className="h-5 w-5" />
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
            variant="accent"
            className="h-auto min-h-12 whitespace-normal py-2 text-left"
            onClick={() => void onContinue()}
          >
            <Play className="h-5 w-5" />
            Continue {resume.name} · {formatClock(resume.positionS)}
          </Button>
        )}
        <Button
          size="lg"
          variant={canContinue ? 'outline' : 'accent'}
          onClick={() => void choose()}
        >
          <Film className="h-5 w-5" />
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
        <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 text-base font-semibold text-foreground">
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
            <PictureInPicture2 className="h-4 w-4" />
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
        'glass glass-hairline absolute left-3 right-3 top-16 z-10 flex flex-col gap-2 rounded-lg p-3 transition-opacity duration-300 sm:left-auto sm:right-3 sm:top-24 sm:w-auto',
        dimmed && 'opacity-20',
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <PictureInPicture2 className="h-5 w-5 text-primary" aria-hidden />
        <p className="text-sm text-foreground">Your show is in picture-in-picture.</p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => void choose()}>
            <Film className="h-4 w-4" />
            Choose videos
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close show" onClick={endShow}>
            <X className="h-5 w-5" />
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

function ShowPlayer({ dimmed }: { dimmed: boolean }) {
  const items = useShowStore((s) => s.items);
  const index = useShowStore((s) => s.index);
  const playing = useShowStore((s) => s.playing);
  const setPlaying = useShowStore((s) => s.setPlaying);
  const next = useShowStore((s) => s.next);
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
    setTime(v.currentTime);
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

  const skip = (seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + seconds));
  };

  const hasNext = index + 1 < items.length;

  return (
    <>
      <div className="relative aspect-video w-full bg-background">
        <video
          ref={videoRef}
          src={item.url}
          className="h-full w-full"
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
              <p className="text-sm text-muted-foreground">Opening {item.title}…</p>
            ) : (
              <p role="alert" className="max-w-prose text-sm font-medium text-destructive">
                {item.title} can’t play in Chrome. Try an MP4 or WebM copy.
              </p>
            )}
          </div>
        )}
      </div>

      <div className={cn('flex flex-col gap-1 px-3 pb-3 pt-2', dimmed && 'hidden')} data-testid="show-controls">
        <label className="flex h-10 items-center gap-3 text-sm text-muted-foreground">
          <span className="num w-14 shrink-0">{formatClock(time)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={1}
            value={Math.min(time, Math.max(duration, 1))}
            onChange={(e) => {
              const v = videoRef.current;
              if (v) v.currentTime = Number(e.target.value);
            }}
            aria-label="Position in video"
            className="h-10 min-w-0 flex-1"
          />
          <span className="num w-14 shrink-0 text-right">{formatClock(duration)}</span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Back 10 seconds" onClick={() => skip(-10)}>
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button
            variant="accent"
            size="lg"
            className="w-12 px-0"
            aria-label={playing ? 'Pause video' : 'Play video'}
            onClick={togglePlay}
          >
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </Button>
          <Button variant="outline" size="icon" aria-label="Forward 30 seconds" onClick={() => skip(30)}>
            <RotateCw className="h-4 w-4" />
          </Button>
          <div className="flex min-w-0 flex-1 basis-40 flex-col px-1">
            <p className="text-base font-semibold text-foreground" data-testid="show-title">
              {item.title}
            </p>
            {items.length > 1 && (
              <p className="num text-xs text-muted-foreground">
                {index + 1} of {items.length}
                {hasNext ? ` · next: ${items[index + 1].title}` : ''}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {items.length > 1 && (
              <Button
                variant="outline"
                size="icon"
                aria-label="Next video"
                disabled={!hasNext}
                onClick={() => next()}
              >
                <SkipForward className="h-4 w-4" />
              </Button>
            )}
            <CameraButton />
            <SizePicker />
            <PopOutButton videoRef={videoRef} />
            <CloseButton />
          </div>
        </div>
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
    <Button
      variant="outline"
      onClick={onClick}
      aria-label={`Camera: ${label}. Switch camera`}
      data-testid="show-camera"
    >
      <Camera className="h-4 w-4" />
      {label}
    </Button>
  );
}

function SizePicker() {
  const size = useShowStore((s) => s.size);
  const setSize = useShowStore((s) => s.setSize);
  return (
    <div
      role="radiogroup"
      aria-label="Video size"
      className="hidden overflow-hidden rounded-md border border-border sm:flex"
    >
      {(['s', 'm', 'l'] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={size === s}
          aria-label={SIZE_LABEL[s]}
          onClick={() => setSize(s)}
          className={cn(
            'h-10 w-11 text-sm font-semibold transition-colors duration-150',
            size === s ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-muted',
          )}
        >
          {s.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function PopOutButton({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement | null> }) {
  if (typeof document === 'undefined' || !document.pictureInPictureEnabled) return null;
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Pop out video"
      onClick={() => {
        const v = videoRef.current;
        if (!v) return;
        if (document.pictureInPictureElement) void document.exitPictureInPicture();
        else void v.requestPictureInPicture().catch(() => undefined);
      }}
    >
      <PictureInPicture2 className="h-4 w-4" />
    </Button>
  );
}

function CloseButton() {
  const endShow = useShowStore((s) => s.endShow);
  return (
    <Button variant="outline" size="icon" aria-label="Close show" onClick={endShow}>
      <X className="h-4 w-4" />
    </Button>
  );
}
