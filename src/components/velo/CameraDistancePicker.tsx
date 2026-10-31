/**
 * Camera distance: how close the chase camera (and the side / orbit /
 * overhead shots) sit to the rider. Standard is the default; Overview is the
 * original far-and-high GlobeRide framing. Lives in Settings → Visual →
 * Camera, which the in-ride settings button opens.
 */

import { useId } from 'react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import { CAMERA_DISTANCES, CAMERA_DISTANCE_LABELS, type CameraDistance } from '@/lib/cesiumCameras';

const HINT: Record<CameraDistance, string> = {
  close: 'Right behind the wheel.',
  standard: 'Rider up front, the road ahead in view.',
  far: 'More of the view, rider smaller.',
  overview: 'High and far, like a map.',
};

export function CameraDistancePicker() {
  const distance = useSettingsStore((s) => s.cameraDistance);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const labelId = useId();
  const hintId = useId();

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-semibold text-foreground">
        Distance
      </span>
      <div role="radiogroup" aria-labelledby={labelId} aria-describedby={hintId} className="flex flex-wrap gap-2">
        {CAMERA_DISTANCES.map((d) => {
          const active = d === distance;
          return (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSettings({ cameraDistance: d })}
              className={cn(
                'h-10 rounded-pill border px-4 text-sm font-semibold transition-colors duration-150',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
              )}
            >
              {CAMERA_DISTANCE_LABELS[d]}
            </button>
          );
        })}
      </div>
      <span id={hintId} className="text-sm text-muted-foreground">
        {HINT[distance]}
      </span>
    </div>
  );
}
