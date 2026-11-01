/**
 * The Devices page (/devices): pair the trainer, the handlebar controls and
 * a heart-rate strap, then ride. Layout per docs/design/mockups/v2-devices.html:
 * device panel | Ride + pairing tips at lg (the Ride button stays above the
 * fold on a TV); one column below lg, with Ride sticky at the bottom on a
 * phone. Pairing only ever starts from the rider's tap.
 */

import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { COLUMN, DISPLAY, KICKER, PAGE_X, WORDMARK } from '@/components/velo/v2';
import { DEVICE_PANEL, ROW_PAD } from '@/components/velo/DeviceRow';
import { rideLine } from '@/components/velo/devicesView';
import { DemoRiderSwitch, ErgSwitch, TrainerModeSwitch, TrainerRow } from '@/components/velo/TrainerPanel';
import { ControllerDebugSwitch, HandlebarRow, useControllerSupported } from '@/components/velo/ControllerPanel';
import { HeartRateRow } from '@/components/velo/HeartRateRow';
import { useRideScenic } from '@/components/velo/ScenicHome';
import { detectBluetoothSupport } from '@/lib/bluetoothSupport';
import {
  characterFor,
  estimateEasyMinutes,
  scenicRouteById,
  todaysScenicRoute,
} from '@/lib/scenicRoutes';
import { useControllerStore } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';

/** Ride the loaded route, else today's scenic ride. */
function RideGo() {
  const navigate = useNavigate();
  const rideScenic = useRideScenic();
  const loaded = useRideStore((s) => s.route);
  const units = useSettingsStore((s) => s.units);
  const controllerSupported = useControllerSupported();
  const controllerStatus = useControllerStore((s) => s.status);

  const scenic = loaded ? scenicRouteById(loaded.id) : todaysScenicRoute();
  const route = loaded ?? scenic?.route;
  const minutes = scenic
    ? scenic.estMinutes
    : route
      ? estimateEasyMinutes(route.totalDistance, characterFor(route.totalDistance, route.ascent, 0))
      : 0;
  // Unpaired controls can still be paired from the ride view's chip.
  const handlebarsCanJoin =
    controllerSupported && (controllerStatus === 'idle' || controllerStatus === 'error');

  const ride = () => {
    if (scenic) rideScenic(scenic);
    else navigate('/ride', { state: { autoStart: true } });
  };

  return (
    <div
      className={cn(
        'sticky bottom-0 z-10 flex flex-col items-start gap-3 border-t border-border bg-background pb-4 pt-3',
        'sm:static sm:border-t-0 sm:bg-transparent sm:p-0 lg:col-start-2 lg:row-start-1 lg:pt-14',
      )}
    >
      <Button variant="primary" size="lg" className="w-full text-base sm:w-auto" onClick={ride} data-testid="devices-ride">
        <Play className="h-5 w-5" aria-hidden />
        Ride
      </Button>
      {route && (
        <span className="text-sm text-muted-foreground">
          {rideLine({
            name: scenic?.name ?? route.name,
            distanceM: route.totalDistance,
            minutes,
            units,
            handlebarsCanJoin,
          })}
        </span>
      )}
    </div>
  );
}

function PairingTips() {
  const titleId = useId();
  return (
    <aside aria-labelledby={titleId} className="lg:col-start-2 lg:row-start-2">
      <h2 id={titleId} className={cn(DISPLAY, 'text-xl')}>
        Pairing the handlebars
      </h2>
      <ol className="mt-3 flex list-decimal flex-col gap-3 pl-5 text-sm">
        <li>Pair the left side: it carries the gears and buttons. Chrome lists both sides as “Zwift Ride”.</li>
        <li>Velo buzzes the one it just connected, so you can feel which side it was.</li>
        <li>If it stays quiet, press a button on it and try again. The row shows how to unlock it if needed.</li>
      </ol>
      <p className="mt-8 border-t border-border pt-4 text-sm text-muted-foreground">
        On an iPad or iPhone? Browsers there can’t pair Bluetooth. You can still ride with the demo rider, or use
        Chrome on the laptop or an Android tablet.
      </p>
    </aside>
  );
}

function OptionsPanel() {
  const titleId = useId();
  const controllerSupported = useControllerSupported();
  return (
    <section aria-labelledby={titleId} className="mt-8">
      <h2 id={titleId} className={KICKER}>
        Options
      </h2>
      <div className={cn(DEVICE_PANEL, 'mt-3')}>
        <div className={ROW_PAD}>
          <ErgSwitch />
        </div>
        <div className={cn(ROW_PAD, 'empty:hidden')}>
          <TrainerModeSwitch />
        </div>
        <div className={cn(ROW_PAD, 'empty:hidden')}>
          <DemoRiderSwitch />
        </div>
        {controllerSupported && (
          <div className={ROW_PAD}>
            <ControllerDebugSwitch />
          </div>
        )}
      </div>
    </section>
  );
}

export function DevicesPanel() {
  const navigate = useNavigate();
  // Capability is fixed for the page's lifetime.
  const [canPair] = useState(() => {
    const bt = detectBluetoothSupport();
    return bt.apiPresent && bt.secureContext;
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className={PAGE_X}>
        <div className={cn(COLUMN, 'flex h-16 items-center justify-between gap-4')}>
          <span className={WORDMARK}>Velo</span>
          <nav aria-label="App">
            <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate('/app')}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Home
            </Button>
          </nav>
        </div>
      </header>

      <main className={cn(PAGE_X, 'pb-10')}>
        <div
          className={cn(
            COLUMN,
            'grid grid-cols-1 gap-8 pt-4 sm:pt-6 lg:grid-cols-devices lg:grid-rows-devices lg:items-start lg:gap-x-12',
          )}
        >
          <div className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <h1 className={cn(DISPLAY, 'text-3xl sm:text-4xl')}>Devices</h1>
            <p className="mt-2 text-base text-muted-foreground">
              Pair once. Next time Velo reconnects by itself when you start a ride.
            </p>

            <section aria-label="Paired devices" className={cn(DEVICE_PANEL, 'mt-6')}>
              <TrainerRow />
              {canPair && <HandlebarRow />}
              {canPair && <HeartRateRow />}
            </section>

            <OptionsPanel />
          </div>

          <RideGo />
          <PairingTips />
        </div>
      </main>
    </div>
  );
}
