/**
 * Trainer pairing and the trainer settings.
 *
 * TrainerRow is the Devices page row (also step 2 of Build your own ride and
 * the in-ride devices sheet): the chooser on a tap, a one-tap reconnect of a
 * granted trainer, disconnect and the troubleshooting guide, rendered from
 * devicesView.trainerRow.
 * DemoRiderSwitch / TrainerModeSwitch are rows of the Devices Options panel.
 * The optional handlebar controls pair separately and never touch the
 * trainer link.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { Gauge } from 'lucide-react';
import { BluetoothTroubleshooter } from '@/components/trainer/BluetoothTroubleshooter';
import { Switch } from '@/components/velo/Switch';
import { DeviceRow } from '@/components/velo/DeviceRow';
import {
  stepForErrorCode,
  stepForReport,
  trainerRow,
  type TrainerActionId,
  type TroubleshootStep,
} from '@/components/velo/devicesView';
import { connect as ftmsConnect, disconnect as ftmsDisconnect, FtmsError, getDeviceName } from '@/lib/ftms';
import {
  detectBluetoothSupport,
  probeBluetoothAdapter,
  type BluetoothSupportReport,
} from '@/lib/bluetoothSupport';
import { checkGrantedTrainer, reconnectGrantedTrainer, useTrainerReconnectStore } from '@/lib/trainerReconnect';
import { useRideStore } from '@/stores/rideStore';

/** A settings row: label + hint on the left, a switch on the right. */
export function SwitchRow({
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

/** Demo rider: simulated power moves the rider (always the case with no trainer streaming). */
export function DemoRiderSwitch() {
  const mode = useRideStore((s) => s.mode);
  const setMode = useRideStore((s) => s.setMode);
  if (mode === 'outdoor') return null;
  const on = mode === 'demo';
  return (
    <SwitchRow
      label="Ride with the demo rider"
      hint={
        on
          ? 'Simulated power moves you, even with a trainer paired.'
          : 'Off: a paired trainer moves you. Without one, the demo rider pedals.'
      }
      checked={on}
      onChange={(next) => setMode(next ? 'demo' : 'trainer')}
    />
  );
}

/** ERG / SIM right now, for a connected trainer. */
export function TrainerModeSwitch() {
  const connection = useRideStore((s) => s.connection);
  const controlMode = useRideStore((s) => s.trainerControlMode);
  const setControlMode = useRideStore((s) => s.setTrainerControlModeSynced);
  const pushToast = useRideStore((s) => s.pushToast);
  if (connection !== 'connected') return null;
  const erg = controlMode === 'erg';
  return (
    <SwitchRow
      label="Hold a fixed power now (ERG)"
      hint={erg ? 'The trainer holds the target power.' : 'Off: the trainer resistance follows the road.'}
      checked={erg}
      onChange={(next) => {
        setControlMode(next ? 'erg' : 'sim');
        pushToast({
          kind: 'info',
          title: next ? 'ERG mode active' : 'Simulation mode active',
          message: next
            ? 'Trainer will hold target power from the workout.'
            : 'Trainer resistance follows the route gradient.',
          durationMs: 3_000,
        });
      }}
    />
  );
}

/** The Devices page trainer row. */
export function TrainerRow() {
  const connection = useRideStore((s) => s.connection);
  const deviceName = useRideStore((s) => s.deviceName);
  const error = useRideStore((s) => s.errorMessage);
  const errorCode = useRideStore((s) => s.errorCode);
  const battery = useRideStore((s) => s.batteryLevel);
  const controlMode = useRideStore((s) => s.trainerControlMode);
  const targetPowerW = useRideStore((s) => s.targetPowerW);
  const setConnection = useRideStore((s) => s.setConnection);
  const setMode = useRideStore((s) => s.setMode);
  const pushToast = useRideStore((s) => s.pushToast);
  const reconnectPhase = useTrainerReconnectStore((s) => s.phase);
  const reconnectName = useTrainerReconnectStore((s) => s.name);
  const reconnectDispatch = useTrainerReconnectStore((s) => s.dispatch);

  const [report, setReport] = useState<BluetoothSupportReport>(() => detectBluetoothSupport());
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStep, setGuideStep] = useState<TroubleshootStep>('wake');

  // A trainer granted in an earlier session can come back without the chooser.
  useEffect(() => {
    void checkGrantedTrainer();
  }, []);
  useEffect(() => {
    let cancelled = false;
    void probeBluetoothAdapter(report).then((full) => {
      if (!cancelled) setReport(full);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The browser can pair at all. A "Bluetooth off" reading can be stale
  // (BlueZ busy for a moment), so it never blocks an attempt.
  const canPair = report.apiPresent && report.secureContext;

  const openGuide = useCallback((step: TroubleshootStep) => {
    setGuideStep(step);
    setGuideOpen(true);
  }, []);

  const handleConnect = useCallback(
    async (opts: { showAllDevices?: boolean } = {}) => {
      if (!canPair) {
        openGuide(stepForReport(report.reasonCode));
        return;
      }
      setConnection('connecting');
      try {
        await ftmsConnect({ showAllDevices: opts.showAllDevices });
        reconnectDispatch({ type: 'paired' });
        setConnection('connected', { deviceName: getDeviceName() });
        setMode('trainer');
        pushToast({
          kind: 'success',
          title: 'Trainer connected',
          message: getDeviceName() ?? 'Live trainer data is streaming.',
          durationMs: 3_500,
        });
      } catch (err) {
        // The row itself shows what went wrong and what to do next.
        const code = err instanceof FtmsError ? err.code : 'unknown';
        const message = err instanceof Error ? err.message : 'Failed to connect';
        setConnection('error', { error: message, code });
      }
    },
    [canPair, report, openGuide, setConnection, setMode, pushToast, reconnectDispatch],
  );

  const handleDisconnect = useCallback(async () => {
    await ftmsDisconnect();
    reconnectDispatch({ type: 'disconnected' });
    setConnection('disconnected', { deviceName: null });
    pushToast({ kind: 'info', title: 'Trainer disconnected', durationMs: 3_000 });
  }, [setConnection, pushToast, reconnectDispatch]);

  const view = trainerRow({
    connection,
    deviceName,
    error,
    errorCode,
    report,
    reconnectPhase: canPair ? reconnectPhase : 'none',
    reconnectName,
    controlMode,
    targetPowerW,
  });

  const onAction = (id: TrainerActionId) => {
    switch (id) {
      case 'pair':
        void handleConnect();
        return;
      case 'pairAll':
        void handleConnect({ showAllDevices: true });
        return;
      case 'reconnect':
        void reconnectGrantedTrainer();
        return;
      case 'disconnect':
        void handleDisconnect();
        return;
      case 'guide':
        openGuide(
          !canPair ? stepForReport(report.reasonCode) : connection === 'error' ? stepForErrorCode(errorCode) : 'wake',
        );
        return;
    }
  };

  return (
    <>
      <DeviceRow
        icon={Gauge}
        view={view}
        onAction={onAction}
        battery={connection !== 'disconnected' && connection !== 'error' ? battery : null}
        quietAction={view.action?.id === 'disconnect'}
        testId="device-trainer"
      />
      <BluetoothTroubleshooter
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        initialStep={guideStep}
        onRetryConnect={canPair ? () => void handleConnect() : undefined}
      />
    </>
  );
}
