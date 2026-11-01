/**
 * Handlebar controls (Ride V2 controllers) inside the Trainer panel.
 * Renders nothing in browsers without Web Bluetooth.
 */

import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/velo/Switch';
import { UnlockSteps } from '@/components/velo/UnlockSteps';
import { BatteryReading } from '@/components/velo/BatteryReading';
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
import {
  ASLEEP_TEXT,
  LOCKED_INTRO,
  MAYBE_RIGHT_TEXT,
  PAIR_OTHER_LABEL,
  RIGHT_SIDE_TEXT,
  UNLOCK_INTRO,
  controllerPhase,
  panelStatusLine,
} from '@/lib/controllers/controllerView';
import { useControllerStore } from '@/stores/controllerStore';

const WAITING_TEXT = 'Press a shift paddle: the gear in the ride view should change.';

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
  const side = useControllerStore((s) => s.side);
  const buzz = useControllerStore((s) => s.buzz);
  const inputSeen = useControllerStore((s) => s.inputSeen);
  const errorMessage = useControllerStore((s) => s.errorMessage);
  const steeringEnabled = useControllerStore((s) => s.steeringEnabled);
  const setSteeringEnabled = useControllerStore((s) => s.setSteeringEnabled);
  const gearBuzz = useControllerStore((s) => s.gearBuzz);
  const setGearBuzz = useControllerStore((s) => s.setGearBuzz);
  const debugOverlay = useControllerStore((s) => s.debugOverlay);
  const setDebugOverlay = useControllerStore((s) => s.setDebugOverlay);
  const titleId = useId();
  const statusId = useId();
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

  const phase = controllerPhase({ status, silent, side, inputSeen });
  const busy = status === 'connecting' || status === 'reconnecting';
  const live = status === 'connected' || status === 'reconnecting';
  const statusLine = panelStatusLine(phase, side, buzz);
  const connected = phase === 'waiting' || phase === 'live' || phase === 'rightSide' || phase === 'silent';
  const pairOther = (
    <Button variant="outline" onClick={() => void pairRideController()}>
      {PAIR_OTHER_LABEL}
    </Button>
  );
  const disconnect = (
    <Button variant="ghost" onClick={() => void disconnectRideController()}>
      Disconnect
    </Button>
  );

  let actions: ReactNode;
  if (status === 'idle' || status === 'error') {
    actions = (
      <>
        {granted && status === 'idle' && !tried && (
          <Button variant="outline" onClick={() => void reconnectGrantedController()}>
            Reconnect {granted}
          </Button>
        )}
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
        <Button variant="ghost" onClick={() => void disconnectRideController({ forget: true })}>
          Forget
        </Button>
      </>
    );
  } else if (phase === 'rightSide') {
    actions = (
      <>
        {pairOther}
        {disconnect}
      </>
    );
  } else if (phase === 'silent') {
    actions = (
      <>
        <Button variant="outline" onClick={() => void reconnectRideController()}>
          Reconnect
        </Button>
        {side !== 'left' && pairOther}
        {disconnect}
      </>
    );
  } else {
    actions = (
      <>
        <Button variant="outline" disabled={status !== 'connected'} onClick={() => void buzzRideController('test')}>
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
              {granted
                ? 'Paired before. Velo reconnects them by itself when you start a ride.'
                : 'Shift gears, set how hard the hills feel and steer from the bars.'}
            </span>
          ) : (
            <span id={statusId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {live && (
                <span
                  aria-hidden
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    phase === 'live' && 'bg-accent',
                    (phase === 'waiting' || phase === 'reconnecting') && 'bg-primary animate-pulse',
                    (phase === 'rightSide' || phase === 'silent') && 'bg-destructive',
                  )}
                />
              )}
              {statusLine}
              {connected && battery !== null && <BatteryReading pct={battery} />}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2" aria-busy={busy}>{actions}</div>
      </div>

      {phase === 'rightSide' && <Note>{RIGHT_SIDE_TEXT}</Note>}
      {phase === 'waiting' && (
        <span className="text-sm text-muted-foreground" role="status">
          {WAITING_TEXT}
        </span>
      )}
      {phase === 'silent' && (
        <>
          <UnlockSteps intro={UNLOCK_INTRO} />
          {side !== 'left' && <Note>{MAYBE_RIGHT_TEXT}</Note>}
        </>
      )}
      {status === 'locked' && <UnlockSteps intro={LOCKED_INTRO} />}
      {status === 'asleep' && <Note>{ASLEEP_TEXT}</Note>}
      {status === 'error' && errorMessage && <Note>{errorMessage}</Note>}

      {live && (
        <>
          <SwitchRow
            label="Steer with the levers"
            hint={
              steeringEnabled
                ? 'The bike follows the road; the levers move you across the lane.'
                : 'Off: the bike stays on the line.'
            }
            checked={steeringEnabled}
            onChange={setSteeringEnabled}
          />
          <SwitchRow
            label="Buzz on gear change"
            hint={gearBuzz ? 'A short buzz on the bars at every shift.' : 'Off: shifting is silent.'}
            checked={gearBuzz}
            onChange={setGearBuzz}
          />
          <details className="group text-sm">
            <summary className="flex h-10 cursor-pointer items-center font-semibold text-foreground">
              What the buttons do
            </summary>
            <Legend rows={ACTION_LEGEND} />
            <p className="pt-4 font-semibold text-foreground">While you watch a video</p>
            <Legend rows={SHOW_LEGEND} />
          </details>
        </>
      )}

      <SwitchRow
        label="Controller debug"
        hint="Shows the last raw messages in the ride view, for a screenshot."
        checked={debugOverlay}
        onChange={setDebugOverlay}
      />
    </section>
  );
}
