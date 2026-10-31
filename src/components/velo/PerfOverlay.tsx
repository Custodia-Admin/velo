/**
 * Ride-view performance readout: frame rate, frame time (mean / p95 / share
 * of frames slower than 30 fps), tile streaming, and the render settings that
 * drive them. Off unless the page is opened with ?perf=1 (same pattern as
 * ?ctrldebug=1). The numbers are the ones window.__veloPerf() returns, so a
 * screenshot from the rider matches scripts/perf-ride.py.
 */

import { useSyncExternalStore } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { getPerfSnapshot, subscribePerf, type ScenePerf } from '@/lib/perf/scenePerf';
import { JANK_MS } from '@/lib/perf/frameStats';
import { QUALITY_LABELS, type GraphicsQuality } from '@/lib/graphicsQuality';
import { useSettingsStore } from '@/stores/settingsStore';

function urlAsksForPerf(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('perf') === '1';
}

const noopSubscribe = () => () => undefined;

/** True when the overlay is on (?perf=1). */
export function usePerfOverlayVisible(): boolean {
  return useSyncExternalStore(noopSubscribe, urlAsksForPerf, () => false);
}

/** Presentational readout — exported for tests and the bug-report sheet. */
export function PerfReadout({
  perf,
  quality,
  className,
}: {
  perf: ScenePerf;
  quality: GraphicsQuality;
  className?: string;
}) {
  const t = perf.tiles;
  const loading = t.globeQueued + t.tilesetPending + t.tilesetProcessing;
  const measuring = perf.frames === 0;
  return (
    <Card
      className={cn('pointer-events-auto flex w-full max-w-sm flex-col gap-1 px-4 py-3', className)}
      role="group"
      aria-label="Performance"
    >
      <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Performance</span>
      <p className="num text-2xl font-semibold text-foreground" data-perf-fps={measuring ? '' : Math.round(perf.fps)}>
        {measuring ? 'Measuring…' : `${Math.round(perf.fps)} fps`}
      </p>
      {!measuring && (
        <p className="font-mono text-xs text-foreground">
          frame {perf.avgMs.toFixed(1)} ms · p95 {perf.p95Ms.toFixed(1)} ms · {Math.round(perf.jankPct)} % over{' '}
          {Math.round(JANK_MS)} ms
        </p>
      )}
      <p className="font-mono text-xs text-foreground" data-perf-tiles={loading}>
        {t.settled ? 'tiles settled' : `tiles loading ${loading} (globe ${t.globeQueued} · 3D ${t.tilesetPending + t.tilesetProcessing})`}
      </p>
      <p className="font-mono text-xs text-muted-foreground">
        {perf.canvas[0]}×{perf.canvas[1]} · scale {perf.resolutionScale.toFixed(2)} · dpr {perf.dpr.toFixed(2)} · MSAA{' '}
        {perf.msaa} · {QUALITY_LABELS[quality].label.toLowerCase()}
        {perf.requestRenderMode ? ' · on demand' : ''}
      </p>
    </Card>
  );
}

export function PerfOverlay({ className }: { className?: string }) {
  const visible = usePerfOverlayVisible();
  const perf = useSyncExternalStore(subscribePerf, getPerfSnapshot, getPerfSnapshot);
  const quality = useSettingsStore((s) => s.graphicsQuality);
  if (!visible) return null;
  return <PerfReadout perf={perf} quality={quality} className={className} />;
}
