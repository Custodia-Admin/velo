/**
 * Handlebar controls (Ride V2 controllers) inside the Trainer panel.
 * Renders nothing in browsers without Web Bluetooth.
 */

import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  buzzRideController,
  disconnectRideController,
  isRideControllerSupported,
  pairRideController,
  reconnectRideController,
} from '@/lib/controllers/rideController';
import { ACTION_LEGEND } from '@/lib/controllers/controllerActions';
import { useControllerStore, type ControllerStatus } from '@/stores/controllerStore';

const STATUS_TEXT: Record<ControllerStatus, string> = {
  idle: 'Not paired',
  connecting: 'Pairing…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  asleep: 'Asleep',
  locked: 'Locked',
  error: 'Not connected',
};

const SILENT_TEXT =
  'No presses yet. Press any button on the bars. If nothing changes, the controls need their daily unlock: connect them once in their own app, close it, then reconnect here.';
const LOCKED_TEXT =
  'The handlebar controls are locked. Connect them once today in their own app, close that app, then press Try again.';
const ASLEEP_TEXT = 'The controls went to sleep. Press any button on the bars, then reconnect.';

const noopSubscribe = () => () => undefined;

function Switch({
  checked,
  onChange,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
  describedBy: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-10 w-16 shrink-0 items-center rounded-pill border transition-colors duration-150',
        checked ? 'border-primary bg-primary' : 'border-muted-foreground/50 bg-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute h-8 w-8 rounded-full shadow-sm transition-transform duration-150',
          checked ? 'translate-x-7 bg-primary-foreground' : 'translate-x-1 bg-muted-foreground',
        )}
      />
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex max-w-prose items-start gap-3 text-sm text-foreground" role="status">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function ControllerPanel() {
  // Capability is fixed for the page's lifetime; read it once without effects.
  const supported = useSyncExternalStore(noopSubscribe, isRideControllerSupported, () => false);
  const status = useControllerStore((s) => s.status);
  const battery = useControllerStore((s) => s.battery);
  const silent = useControllerStore((s) => s.silent);
  const errorMessage = useControllerStore((s) => s.errorMessage);
  const steeringEnabled = useControllerStore((s) => s.steeringEnabled);
  const setSteeringEnabled = useControllerStore((s) => s.setSteeringEnabled);
  const titleId = useId();
  const statusId = useId();
  const steerLabelId = useId();
  const steerHintId = useId();
  // After a pairing attempt that didn't connect (chooser empty or closed),
  // offer the unfiltered chooser too.
  const [tried, setTried] = useState(false);

  if (!supported) return null;

  const busy = status === 'connecting' || status === 'reconnecting';
  const live = status === 'connected' || status === 'reconnecting';
  const statusLine =
    status === 'connected' && battery !== null ? `Connected · battery ${battery} %` : STATUS_TEXT[status];

  let actions: ReactNode;
  if (status === 'idle' || status === 'error') {
    actions = (
      <>
        <Button
          variant="outline"
          onClick={() => {
            setTried(true);
            void pairRideController();
          }}
        >
          {status === 'error' || tried ? 'Try again' : 'Pair handlebar controls'}
        </Button>
        {tried && (
          <Button variant="ghost" onClick={() => void pairRideController({ showAllDevices: true })}>
            Show all devices
          </Button>
        )}
      </>
    );
  } else if (status === 'connecting') {
    actions = (
      <Button variant="outline" disabled aria-busy>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Pairing…
      </Button>
    );
  } else if (status === 'locked' || status === 'asleep') {
    actions = (
      <>
        <Button variant="outline" onClick={() => void reconnectRideController()}>
          {status === 'locked' ? 'Try again' : 'Reconnect'}
        </Button>
        <Button variant="ghost" onClick={() => void disconnectRideController()}>
          Forget
        </Button>
      </>
    );
  } else {
    actions = (
      <>
        <Button variant="outline" disabled={status !== 'connected'} onClick={buzzRideController}>
          Test buzz
        </Button>
        <Button variant="outline" onClick={() => void disconnectRideController()}>
          Disconnect
        </Button>
      </>
    );
  }

  return (
    <section aria-labelledby={titleId} aria-describedby={statusId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <h3 id={titleId} className="text-sm font-semibold text-foreground">
            Handlebar controls
          </h3>
          {status === 'idle' ? (
            <span id={statusId} className="text-sm text-muted-foreground">
              Shift gears, set how hard the hills feel and steer from the bars.
            </span>
          ) : (
            <span id={statusId} className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              {live && (
                <span
                  aria-hidden
                  className={cn('h-2 w-2 rounded-full', status === 'connected' ? 'bg-accent' : 'bg-muted-foreground animate-pulse')}
                />
              )}
              {statusLine}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2" aria-busy={busy}>{actions}</div>
      </div>

      {status === 'connected' && silent && <Note>{SILENT_TEXT}</Note>}
      {status === 'locked' && <Note>{LOCKED_TEXT}</Note>}
      {status === 'asleep' && <Note>{ASLEEP_TEXT}</Note>}
      {status === 'error' && errorMessage && <Note>{errorMessage}</Note>}

      {live && (
        <>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span id={steerLabelId} className="text-sm font-semibold text-foreground">
                Steer with the levers
              </span>
              <span id={steerHintId} className="text-sm text-muted-foreground">
                {steeringEnabled
                  ? 'The bike follows the road; the levers move you across the lane.'
                  : 'Off: the bike stays on the line.'}
              </span>
            </div>
            <Switch
              checked={steeringEnabled}
              onChange={setSteeringEnabled}
              labelledBy={steerLabelId}
              describedBy={steerHintId}
            />
          </div>
          <details className="group text-sm">
            <summary className="flex h-10 cursor-pointer items-center font-semibold text-foreground">
              What the buttons do
            </summary>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 pt-2 sm:grid-cols-2">
              {ACTION_LEGEND.map((row) => (
                <div key={row.controls} className="flex flex-col gap-1">
                  <dt className="font-semibold text-foreground">{row.controls}</dt>
                  <dd className="text-muted-foreground">{row.action}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
