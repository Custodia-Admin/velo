/**
 * Home's top bar (v2 home mockup): the Velo wordmark, then Devices (trainer
 * state at a glance; opens /devices), a day/night toggle and Settings.
 * Scrolls with the page (not sticky).
 */

import { useNavigate } from 'react-router-dom';
import { Bluetooth, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsButton } from '@/components/profile/SettingsPanel';
import { cn } from '@/lib/utils';
import { useRideStore } from '@/stores/rideStore';
import { useThemeStore } from '@/stores/themeStore';
import { COLUMN, PAGE_X, WORDMARK } from '@/components/velo/v2';

/** Devices button copy: the paired trainer's name when connected. */
export function devicesButtonText(connected: boolean, deviceName: string | null): { label: string; ariaLabel: string } {
  return connected
    ? { label: deviceName || 'Trainer', ariaLabel: 'Devices: trainer connected' }
    : { label: 'Devices', ariaLabel: 'Devices: no trainer paired' };
}

export function HomeHeader() {
  const navigate = useNavigate();
  const connected = useRideStore((s) => s.connection === 'connected');
  const deviceName = useRideStore((s) => s.deviceName);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const night = theme === 'dark';
  const devices = devicesButtonText(connected, deviceName);

  return (
    <header className={PAGE_X}>
      <div className={cn(COLUMN, 'flex h-16 items-center justify-between gap-4')}>
        <span className={cn(WORDMARK, 'text-foreground')}>Velo</span>
        <nav aria-label="App" className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => navigate('/devices')}
            aria-label={devices.ariaLabel}
          >
            <Bluetooth className="h-4 w-4" />
            <span className="hidden sm:inline">{devices.label}</span>
            <span
              aria-hidden
              className={cn('h-2 w-2 shrink-0 rounded-full', connected ? 'bg-primary' : 'bg-muted-foreground')}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            onClick={toggleTheme}
            aria-label={night ? 'Switch to day theme' : 'Switch to night theme'}
          >
            {night ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
          <SettingsButton variant="ghost" className="text-muted-foreground" />
        </nav>
      </div>
    </header>
  );
}
