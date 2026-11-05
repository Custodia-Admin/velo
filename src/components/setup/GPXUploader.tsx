import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, BookmarkPlus, Check, Loader2, Sparkles, Upload } from 'lucide-react';

import { useRideStore } from '@/stores/rideStore';
import { parseGpx } from '@/lib/gpxParser';
import { makeDemoRoute } from '@/lib/sampleRoutes';
import { hasRoute, saveRoute } from '@/lib/routeLibrary';
import { Button } from '@/components/ui/button';
import { DISPLAY } from '@/components/velo/v2';
import { cn } from '@/lib/utils';
import type { Route } from '@/types';

/**
 * Id of the last route this uploader loaded (a GPX or the demo loop). Module
 * scope, so it survives the route step closing and opening again; the loaded
 * route shows only while it is still the ride's route, never for a scenic
 * pick or a generated route.
 */
let lastLoadedId: string | null = null;

/**
 * "Ride your own route" (Home → Build your own ride, step 1): one Upload GPX
 * button (the file picker), the whole row as a drop target, a one-click demo
 * loop, and the loaded route as a picked tile with Save. On-system
 * (UI-RULES §2, checked by src/test/uiRules.test.ts).
 */
export function GPXUploader() {
  const setRoute       = useRideStore((s) => s.setRoute);
  const route          = useRideStore((s) => s.route);
  const bumpLibrary    = useRideStore((s) => s.bumpLibrary);
  const libraryVersion = useRideStore((s) => s.libraryVersion);
  const inputRef       = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [dragOver, setDragOver]       = useState(false);
  const [savedInLibrary, setSavedInLibrary] = useState(false);
  const [saving, setSaving]           = useState(false);
  const [loadedId, setLoadedId]       = useState<string | null>(lastLoadedId);

  const loaded = route !== null && route.id === loadedId ? route : null;

  const load = useCallback(
    (r: Route) => {
      lastLoadedId = r.id;
      setLoadedId(r.id);
      setRoute(r);
    },
    [setRoute],
  );

  useEffect(() => {
    let alive = true;
    if (!loaded) { setSavedInLibrary(false); return; }
    hasRoute(loaded.id)
      .then((exists) => { if (alive) setSavedInLibrary(exists); })
      .catch(() => { if (alive) setSavedInLibrary(false); });
    return () => { alive = false; };
  }, [loaded, libraryVersion]);

  const handleSave = useCallback(async () => {
    if (!loaded || savedInLibrary || saving) return;
    setSaving(true);
    try {
      await saveRoute(loaded, 'gpx');
      setSavedInLibrary(true);
      bumpLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save route');
    } finally {
      setSaving(false);
    }
  }, [loaded, savedInLibrary, saving, bumpLibrary]);

  const handleFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const xml = await file.text();
        load(parseGpx(xml, file.name.replace(/\.gpx$/i, '')));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not parse GPX file');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) void handleFile(f);
      }}
      // The drop target lights up only while a file is dragged over it (an
      // outline, so nothing shifts).
      className={cn(
        'flex flex-col gap-3 rounded-md transition-colors duration-150',
        dragOver && 'bg-primary/10 outline-dashed outline-2 outline-offset-4 outline-primary',
      )}
      data-gpx-dropzone
    >
      <input
        ref={inputRef}
        type="file"
        accept=".gpx,application/gpx+xml,text/xml"
        aria-label="Upload GPX route file"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void handleFile(f);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="max-w-prose text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">Or ride your own route.</span> Upload a GPX file from
          Strava, Komoot, Garmin or RideWithGPS, or drag one here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
            {busy ? 'Reading…' : 'Upload GPX'}
          </Button>
          <Button variant="quiet" onClick={() => load(makeDemoRoute())}>
            <Sparkles className="h-4 w-4" aria-hidden />
            Demo route
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      {/* The loaded route, drawn as a picked tile (the scenic tiles' selected state). */}
      {loaded && (
        <div
          className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-md border border-primary bg-primary/10 px-3 py-2 animate-fadeUp"
          data-gpx-loaded
        >
          <div className="min-w-0">
            <p className={cn(DISPLAY, 'text-lg text-foreground')}>
              <span className="sr-only">Riding: </span>
              {loaded.name}
            </p>
            <p className="num text-sm text-muted-foreground">
              {(loaded.totalDistance / 1000).toFixed(1)} km · {Math.round(loaded.ascent)} m up ·{' '}
              {Math.round(loaded.descent)} m down
            </p>
          </div>
          <Button
            variant="outline"
            disabled={savedInLibrary || saving}
            aria-busy={saving || undefined}
            onClick={() => void handleSave()}
            title={savedInLibrary ? 'Already saved in this browser' : 'Save this route in this browser'}
          >
            {saving
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              : savedInLibrary
                ? <><Check className="h-4 w-4" aria-hidden /> Saved</>
                : <><BookmarkPlus className="h-4 w-4" aria-hidden /> Save</>
            }
          </Button>
        </div>
      )}
    </div>
  );
}
