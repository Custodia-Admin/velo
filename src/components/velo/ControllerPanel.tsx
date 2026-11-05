/**
 * Handlebar controls (Ride V2 controllers).
 *
 * HandlebarRow is the handlebar row of the Devices page and of the in-ride
 * devices sheet (rendered from devicesView.handlebarRow). It drives the
 * single-controller store and lib calls, and renders nothing in browsers
 * without Web Bluetooth.
 */

import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Bluetooth } from 'lucide-react';
import { DeviceRow } from '@/components/velo/DeviceRow';
import { handlebarRow, type HandlebarActionId } from '@/components/velo/devicesView';
import { Switch } from '@/components/velo/Switch';
import { UnlockSteps } from '@/components/velo/UnlockSteps';
import { cn } from '@/lib/utils';
import {
  buzzRideController,
  disconnectRideController,
  findGrantedController,
  isRideControllerSupported,
  pairRideController,
  reconnectGrantedController,
  reconnectRideController,
} from '@/lib/controllers/rideController';
import { ACTION_LEGEND, SHOW_LEGEND, type LegendRow } from '@/lib/controllers/controllerActions';
import { useControllerStore } from '@/stores/controllerStore';


const noopSubscribe = () => () => undefined;

function Legend({ rows }: { rows: ReadonlyArray<LegendRow> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 pt-2 sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.controls} className="flex flex-col gap-1">
          <dt className="font-semibold text-foreground">{row.controls}</dt>
          <dd className="text-muted-foreground">{row.action}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One labelled on/off row (label, one-line hint, switch). */
function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span id={labelId} className="text-sm font-semibold text-foreground">
          {label}
        </span>
        <span id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </span>
      </div>
      <Switch checked={checked} onChange={onChange} labelledBy={labelId} describedBy={hintId} />
    </div>
  );
}

/** "Steer with the levers" on/off (persisted in the controller store). */
export function SteeringSwitch() {
  const steeringEnabled = useControllerStore((s) => s.steeringEnabled);
  const setSteeringEnabled = useControllerStore((s) => s.setSteeringEnabled);
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span id={labelId} className="text-sm font-semibold text-foreground">
          Steer with the levers
        </span>
        <span id={hintId} className="text-sm text-muted-foreground">
          {steeringEnabled
            ? 'The bike follows the road; the levers move you across the lane.'
            : 'Off: the bike stays on the line.'}
        </span>
      </div>
      <Switch checked={steeringEnabled} onChange={setSteeringEnabled} labelledBy={labelId} describedBy={hintId} />
    </div>
  );
}

/** "What the buttons do": the action legend behind a disclosure. */
export function ButtonLegend({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <details className={cn('group text-sm', className)}>
      <summary className="flex h-10 cursor-pointer items-center font-semibold text-foreground">
        What the buttons do
      </summary>
      <Legend rows={ACTION_LEGEND} />
      {children}
    </details>
  );
}

/** The buttons' second map, used while a show video plays. */
export function ShowLegend() {
  return (
    <>
      <p className="pt-4 font-semibold text-foreground">While you watch a video</p>
      <Legend rows={SHOW_LEGEND} />
    </>
  );
}

/** "Buzz on gear change" on/off (persisted in the controller store). */
export function GearBuzzSwitch() {
  const gearBuzz = useControllerStore((s) => s.gearBuzz);
  const setGearBuzz = useControllerStore((s) => s.setGearBuzz);
  return (
    <SwitchRow
      label="Buzz on gear change"
      hint={gearBuzz ? 'A short buzz on the bars at every shift.' : 'Off: shifting is silent.'}
      checked={gearBuzz}
      onChange={setGearBuzz}
    />
  );
}

/** Raw-message overlay in the ride view (field diagnostics). */
export function ControllerDebugSwitch() {
  const debugOverlay = useControllerStore((s) => s.debugOverlay);
  const setDebugOverlay = useControllerStore((s) => s.setDebugOverlay);
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span id={labelId} className="text-sm font-semibold text-foreground">
          Controller debug
        </span>
        <span id={hintId} className="text-sm text-muted-foreground">
          Shows the last raw messages in the ride view, for a screenshot.
        </span>
      </div>
      <Switch checked={debugOverlay} onChange={setDebugOverlay} labelledBy={labelId} describedBy={hintId} />
    </div>
  );
}

/** Web Bluetooth is there (fixed for the page's lifetime; read once without effects). */
export function useControllerSupported(): boolean {
  return useSyncExternalStore(noopSubscribe, isRideControllerSupported, () => false);
}

/** The Devices page handlebar row. Nothing without Web Bluetooth. */
export function HandlebarRow() {
  const supported = useControllerSupported();
  const status = useControllerStore((s) => s.status);
  const battery = useControllerStore((s) => s.battery);
  const silent = useControllerStore((s) => s.silent);
  const side = useControllerStore((s) => s.side);
  const buzz = useControllerStore((s) => s.buzz);
  const inputSeen = useControllerStore((s) => s.inputSeen);
  const deviceName = useControllerStore((s) => s.deviceName);
  const errorMessage = useControllerStore((s) => s.errorMessage);
  const wakeArmed = useControllerStore((s) => s.wakeArmed);
  // After a pairing attempt that didn't connect (chooser empty or closed),
  // offer the unfiltered chooser too.
  const [tried, setTried] = useState(false);
  // Controls paired in an earlier session: one tap, no chooser. Reading the
  // grant list (getDevices) sends nothing to any device.
  const [granted, setGranted] = useState<string | null>(null);
  useEffect(() => {
    if (!supported || status !== 'idle') return undefined;
    let cancelled = false;
    void findGrantedController().then((dev) => {
      if (!cancelled) setGranted(dev ? (dev.name ?? 'Handlebar controls') : null);
    });
    return () => {
      cancelled = true;
    };
  }, [supported, status]);

  if (!supported) return null;

  const view = handlebarRow({ status, silent, side, inputSeen, buzz, deviceName, errorMessage, tried, granted, wakeArmed });

  const onAction = (id: HandlebarActionId) => {
    switch (id) {
      case 'pair':
        setTried(true);
        void pairRideController();
        return;
      case 'pairAll':
        void pairRideController({ showAllDevices: true });
        return;
      case 'pairOther':
        void pairRideController();
        return;
      case 'reconnect':
        void reconnectRideController();
        return;
      case 'reconnectGranted':
        // A tap: the confirm buzz and RideOn are the rider's own doing.
        void reconnectGrantedController();
        return;
      case 'buzz':
        buzzRideController();
        return;
      case 'disconnect':
        void disconnectRideController();
        return;
      case 'forget':
        // Also drops the remembered device, so the next ride doesn't reconnect it.
        void disconnectRideController({ forget: true });
        return;
    }
  };

  return (
    <DeviceRow
      icon={Bluetooth}
      view={view}
      onAction={onAction}
      battery={view.showBattery ? battery : null}
      testId="device-handlebar"
      extrasLead={
        view.settings && (
          <ButtonLegend className="open:basis-full">
            <ShowLegend />
            <div className="flex flex-col gap-4 pt-4">
              <SteeringSwitch />
              <GearBuzzSwitch />
            </div>
          </ButtonLegend>
        )
      }
    >
      {view.unlockIntro && (
        <div className="mt-2">
          <UnlockSteps intro={view.unlockIntro} />
        </div>
      )}
    </DeviceRow>
  );
}
