/**
 * In-ride weather chip: live conditions at the route plus where the wind
 * comes from relative to the rider right now. Falls back to the manual wind
 * setting when live weather is off or unavailable; hidden when there is
 * nothing to say.
 */

import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  type LucideIcon,
} from 'lucide-react';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRouteWeather } from '@/hooks/useLiveWeather';
import { headingAt } from '@/lib/gpxParser';
import { conditionFor } from '@/lib/meteo/sceneWeather';
import { relativeWindDeg } from '@/lib/meteo/windFeel';
import { CALM_MS, hudConditionText, hudWindText } from '@/lib/meteo/weatherText';
import { WeatherIcon } from '@/components/velo/WeatherIcon';

/** Arrows for the direction the wind travels on screen (up = straight ahead). */
const ARROWS: LucideIcon[] = [
  ArrowUp,
  ArrowUpRight,
  ArrowRight,
  ArrowDownRight,
  ArrowDown,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpLeft,
];

/** Arrow for wind coming FROM `relDeg` (0 = in the face): it travels the opposite way. */
export function windArrowIndex(relDeg: number): number {
  const travel = (((relDeg + 180) % 360) + 360) % 360;
  return Math.round(travel / 45) % 8;
}

export function RideWeatherChip() {
  const route = useRideStore((s) => s.route);
  const distance = useRideStore((s) => s.distance);
  const units = useSettingsStore((s) => s.units);
  const manualWindMs = useSettingsStore((s) => s.windSpeedMs);
  const manualWindDeg = useSettingsStore((s) => s.windDirectionDeg);
  const entry = useRouteWeather(route);
  const live = entry?.status === 'ready' ? entry.weather : null;

  let windMs: number;
  let relDeg: number;
  if (live && route) {
    const bearingDeg = (headingAt(route, distance) * 180) / Math.PI;
    windMs = live.windSpeedMs;
    relDeg = relativeWindDeg(live.windFromDeg, bearingDeg);
  } else {
    windMs = manualWindMs;
    relDeg = manualWindDeg;
  }

  const showWind = windMs >= CALM_MS;
  if (!live && !showWind) return null;

  const Arrow = ARROWS[windArrowIndex(relDeg)];
  const windText = hudWindText(windMs, relDeg, units);
  const conditionText = live ? hudConditionText(live, units) : '';
  const label = [conditionText, windText].filter(Boolean).join(', ');

  return (
    <div
      role="status"
      aria-label={`Weather: ${label}`}
      className="pointer-events-auto glass glass-hairline flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-sm text-foreground"
      data-testid="ride-weather-chip"
    >
      {live && (
        <span className="flex items-center gap-2" aria-hidden>
          <WeatherIcon condition={conditionFor(live)} isDay={live.isDay} className="h-4 w-4 shrink-0 text-primary" />
          <span className="num font-semibold">{conditionText}</span>
        </span>
      )}
      <span className="flex items-center gap-2" aria-hidden>
        {showWind && <Arrow className="h-4 w-4 shrink-0 text-primary" />}
        <span className="num">{windText}</span>
      </span>
    </div>
  );
}
