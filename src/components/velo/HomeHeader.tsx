/**
 * Home's top bar (v2 home mockup): the Velo wordmark, then the device pill
 * (the trainer's name and a status dot; opens /devices) and Settings —
 * exactly the mockup's bar. Day / night lives in Settings > Visual (and the
 * ride's Settings menu). Scrolls with the page.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bluetooth } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsButton } from '@/components/profile/SettingsPanel';
import { cn } from '@/lib/utils';
import { checkGrantedTrainer, useTrainerReconnectStore } from '@/lib/trainerReconnect';
import { useRideStore } from '@/stores/rideStore';
import { COLUMN, PAGE_X, WORDMARK } from '@/components/velo/v2';
import { shortDeviceName } from '@/components/velo/rideHudText';

/**
 * Device pill copy: the trainer's model name ("KICKR CORE") when one is
 * connected or paired in an earlier session (the dot tells which), else
 * "Devices".
 */
export function devicesButtonText(
  connected: boolean,
  deviceName: string | null,
  pairedName: string | null = null,
): { label: string; ariaLabel: string; on: boolean } {
  if (connected) {
    const name = deviceName?.trim() || 'Trainer';
    return { label: shortDeviceName(name), ariaLabel: `Devices: ${name} connected`, on: true };
  }
  if (pairedName?.trim()) {
    const name = pairedName.trim();
    return { label: shortDeviceName(name), ariaLabel: `Devices: ${name} paired, not connected`, on: false };
  }
  return { label: 'Devices', ariaLabel: 'Devices: no trainer paired', on: false };
}

export function HomeHeader() {
  const navigate = useNavigate();
  const connected = useRideStore((s) => s.connection === 'connected');
  const deviceName = useRideStore((s) => s.deviceName);
  const pairedName = useTrainerReconnectStore((s) => (s.phase === 'none' ? null : s.name));
  // Read-only: asks the browser which trainer is already granted (no BLE traffic).
  useEffect(() => {
    void checkGrantedTrainer();
  }, []);
  const devices = devicesButtonText(connected, deviceName, pairedName);

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
              className={cn('h-2 w-2 shrink-0 rounded-full', devices.on ? 'bg-primary' : 'bg-muted-foreground')}
            />
          </Button>
          <SettingsButton variant="ghost" className="text-muted-foreground" />
        </nav>
      </div>
    </header>
  );
}
