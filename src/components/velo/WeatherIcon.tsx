/**
 * Lucide icon for a weather condition (moon variants at night).
 */

import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Moon,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import type { WeatherCondition } from '@/lib/meteo/sceneWeather';

const ICONS: Record<WeatherCondition, LucideIcon> = {
  clear: Sun,
  'partly-cloudy': CloudSun,
  overcast: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
};

export function WeatherIcon({
  condition,
  isDay,
  className,
}: {
  condition: WeatherCondition;
  isDay: boolean;
  className?: string;
}) {
  const Icon = isDay
    ? ICONS[condition]
    : condition === 'clear'
      ? Moon
      : condition === 'partly-cloudy'
        ? CloudMoon
        : ICONS[condition];
  return <Icon aria-hidden className={className} />;
}
