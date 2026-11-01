/**
 * Handlebar controls (Ride V2 controllers).
 *
 * HandlebarRow is the Devices page row (rendered from
 * devicesView.handlebarRow); ControllerPanel is the older block inside the
 * Home Trainer card. Both drive the same single-controller store and lib
 * calls, and render nothing in browsers without Web Bluetooth.
 */

import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlertCircle, Bluetooth, Loader2 } from 'lucide-react';
import { DeviceRow } from '@/components/velo/DeviceRow';
import { ASLEEP_TEXT, WAITING_TEXT, handlebarRow, type HandlebarActionId } from '@/components/velo/devicesView';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/velo/Switch';
import { UnlockSteps } from '@/components/velo/UnlockSteps';
import { cn } from '@/lib/utils';
import {
  buzzRideController,
  disconnectRideController,
  isRideControllerSupported,
  pairRideController,
  reconnectRideController,
} from '@/lib/controllers/rideController';
import { ACTION_LEGEND } from '@/lib/controllers/controllerActions';
import {
  LOCKED_INTRO,
  MAYBE_RIGHT_TEXT,
  PAIR_OTHER_LABEL,
  RIGHT_SIDE_TEXT,
  UNLOCK_INTRO,
  controllerPhase,
  panelStatusLine,
} from '@/lib/controllers/controllerView';
import { useControllerStore } from '@/stores/controllerStore';


const noopSubscribe = () => () => undefined;

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex max-w-prose items-start gap-3 text-sm text-foreground" role="status">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function ControllerPanel() {
  const supported = useControllerSupported();
  const status = useControllerStore((s) => s.status);
  const battery = useControllerStore((s) => s.battery);
  const silent = useControllerStore((s) => s.silent);
  const side = useControllerStore((s) => s.side);
  const buzz = useControllerStore((s) => s.buzz);
  const inputSeen = useControllerStore((s) => s.inputSeen);
  const errorMessage = useControllerStore((s) => s.errorMessage);
  const titleId = useId();
  const statusId = useId();
  // After a pairing attempt that didn't connect (chooser empty or closed),
  // offer the unfiltered chooser too.
  const [tried, setTried] = useState(false);

  if (!supported) return null;

  const phase = controllerPhase({ status, silent, side, inputSeen });
  const busy = status === 'connecting' || status === 'reconnecting';
  const live = status === 'connected' || status === 'reconnecting';
  const statusLine = panelStatusLine(phase, side, buzz, battery);
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
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    phase === 'live' && 'bg-accent',
                    (phase === 'waiting' || phase === 'reconnecting') && 'bg-primary animate-pulse',
                    (phase === 'rightSide' || phase === 'silent') && 'bg-destructive',
                  )}
                />
              )}
              {statusLine}
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
          <SteeringSwitch />
          <ButtonLegend />
        </>
      )}

      <ControllerDebugSwitch />
    </section>
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
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 pt-2 sm:grid-cols-2">
        {ACTION_LEGEND.map((row) => (
          <div key={row.controls} className="flex flex-col gap-1">
            <dt className="font-semibold text-foreground">{row.controls}</dt>
            <dd className="text-muted-foreground">{row.action}</dd>
          </div>
        ))}
      </dl>
      {children}
    </details>
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
  // After a pairing attempt that didn't connect (chooser empty or closed),
  // offer the unfiltered chooser too.
  const [tried, setTried] = useState(false);

  if (!supported) return null;

  const view = handlebarRow({ status, silent, side, inputSeen, buzz, deviceName, errorMessage, tried });

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
      case 'buzz':
        buzzRideController();
        return;
      case 'disconnect':
      case 'forget':
        void disconnectRideController();
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
            <div className="pt-4">
              <SteeringSwitch />
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
