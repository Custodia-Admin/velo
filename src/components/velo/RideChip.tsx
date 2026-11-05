/**
 * The one in-ride status chip (compact ride HUD, owner-directed revision
 * 2 Nov 2026, docs/design/mockups/v2-ride-hud.html): trainer, handlebar
 * controls, heart-rate strap and passing notices in one small pill above
 * the ride band, worst problem first (`rideChip`, rideHudText.ts). Never a
 * large red box: details live on the devices sheet the chip opens.
 *
 * Tapping it (`chipTap`, rideHudText.ts): "Trainer lost · tap to reconnect"
 * reconnects the granted trainer (the Devices row's own action); "The 3D
 * view stopped · tap to reload the view" (the world canvas lost its WebGL
 * context, stores/worldViewStore) remounts the world view; a notice
 * with an action runs it; anything else opens the devices sheet. The
 * reconnect label needs a trainer grant the app can use
 * (useTrainerReconnectStore phase 'available' / 'failed'); a trainer lost
 * without one reads "Trainer lost · tap for devices".
 *
 * While the chip is mounted, toasts are not drawn (Toaster defers to the
 * chip): the newest one holds the chip for at most 5 s and is then
 * dismissed, so nothing piles up for the finish page.
 *
 * Below sm the calm states hide (the band is the whole HUD there); the chip
 * shows only when something needs the rider. `alertsOnly` (show mode, over
 * the video) hides the calm states on every viewport.
 *
 * `aside` (card t_375b203d): a quiet notice that shares the chip's lane, at
 * its far end (the photoreal notice; the caller stretches the lane to the
 * band). It must always render something. It shows while the chip is calm
 * (alone on phones, where the calm chip is hidden) and steps aside while
 * the chip carries an alert, so one thing speaks at a time and the lane
 * stays one h-10 row.
 */

import { useEffect, useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { controllerPhase } from '@/lib/controllers/controllerView';
import { reconnectGrantedTrainer, useTrainerReconnectStore } from '@/lib/trainerReconnect';
import { useControllerStore } from '@/stores/controllerStore';
import { useRideHudStore } from '@/stores/rideHudStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { selectWorldStopped, useWorldViewStore } from '@/stores/worldViewStore';
import { HUD_PANEL } from './v2';
import { chipTap, noticeMs, rideChip, type ChipNotice } from './rideHudText';

/** The newest toast, shown in the chip; each one is dismissed after its turn. */
export function useRideNotice(): (ChipNotice & { id: string; run?: () => void }) | null {
  const hostNotices = useRideHudStore((s) => s.hostNotices);
  useEffect(() => hostNotices(), [hostNotices]);

  const latest = useRideStore((s) => (s.toasts.length > 0 ? s.toasts[s.toasts.length - 1] : null));
  const older = useRideStore((s) => s.toasts.length > 1);
  const dismiss = useRideStore((s) => s.dismissToast);

  // Older toasts never get a turn: the newest one speaks.
  useEffect(() => {
    if (!older || !latest) return;
    for (const t of useRideStore.getState().toasts) if (t.id !== latest.id) dismiss(t.id);
  }, [older, latest, dismiss]);

  useEffect(() => {
    if (!latest) return undefined;
    const handle = window.setTimeout(() => dismiss(latest.id), noticeMs(latest.durationMs));
    return () => window.clearTimeout(handle);
  }, [latest, dismiss]);

  return useMemo(() => {
    if (!latest) return null;
    return {
      id: latest.id,
      title: latest.title,
      kind: latest.kind,
      actionLabel: latest.action?.label,
      run: latest.action?.onClick,
    };
  }, [latest]);
}

export function RideChip({
  className,
  alertsOnly = false,
  aside,
}: {
  className?: string;
  alertsOnly?: boolean;
  aside?: ReactNode;
}) {
  const connection = useRideStore((s) => s.connection);
  const mode = useRideStore((s) => (s.rideMode === 'outdoor' ? 'outdoor' : s.mode));
  const deviceName = useRideStore((s) => s.deviceName);
  const erg = useRideStore((s) => s.trainerControlMode === 'erg');
  const targetPowerW = useRideStore((s) => s.targetPowerW);
  const battery = useRideStore((s) => s.batteryLevel);
  const reconnectAttempt = useRideStore((s) => s.reconnectAttempt);
  const reconnectMaxAttempts = useRideStore((s) => s.reconnectMaxAttempts);
  const errorCode = useRideStore((s) => s.errorCode);
  const heartRate = useRideStore((s) => s.hrSensorStatus);
  const difficulty = useSettingsStore((s) => s.trainerDifficulty);
  const reconnectPhase = useTrainerReconnectStore((s) => s.phase);
  const ctrlStatus = useControllerStore((s) => s.status);
  const ctrlSilent = useControllerStore((s) => s.silent);
  const ctrlSide = useControllerStore((s) => s.side);
  const ctrlInputSeen = useControllerStore((s) => s.inputSeen);
  const setDevicesOpen = useRideHudStore((s) => s.setDevicesOpen);
  const devicesOpen = useRideHudStore((s) => s.devicesOpen);
  const worldStopped = useWorldViewStore(selectWorldStopped);
  const notice = useRideNotice();

  const view = rideChip({
    connection,
    mode,
    deviceName,
    difficulty,
    erg,
    targetPowerW,
    battery,
    reconnectAttempt,
    reconnectMaxAttempts,
    trainerReconnectable: reconnectPhase === 'available' || reconnectPhase === 'failed',
    errorCode,
    controls: controllerPhase({ status: ctrlStatus, silent: ctrlSilent, side: ctrlSide, inputSeen: ctrlInputSeen }),
    heartRate,
    notice,
    worldStopped,
  });

  const onTap = () => {
    chipTap(view.action, notice, {
      reconnectTrainer: () => void reconnectGrantedTrainer(),
      reloadWorld: () => useWorldViewStore.getState().reload(),
      dismissNotice: (id) => useRideStore.getState().dismissToast(id),
      toggleDevices: () => setDevicesOpen(!devicesOpen),
    });
  };

  const lane = aside !== undefined && aside !== null;
  const button = (
    <button
      type="button"
      aria-live="polite"
      aria-label={view.aria}
      aria-expanded={view.action === 'devices' ? devicesOpen : undefined}
      aria-controls={view.action === 'devices' ? 'ride-devices-sheet' : undefined}
      title={view.aria}
      data-testid="ride-status-chip"
      data-tone={view.tone}
      onClick={onTap}
      className={cn(
        HUD_PANEL,
        'pointer-events-auto h-10 max-w-full items-center gap-2 border border-border/60 px-3 text-sm font-semibold sm:max-w-sm',
        view.alert ? 'inline-flex' : 'hidden sm:inline-flex',
        lane ? 'shrink-0' : className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          view.tone === 'ok' && 'bg-primary',
          view.tone === 'calm' && 'bg-muted-foreground',
          view.tone === 'warn' && 'bg-destructive',
          view.pulse && 'animate-pulse',
        )}
      />
      <span aria-hidden="true" className="truncate">
        {view.label}
      </span>
    </button>
  );
  const chip = alertsOnly && !view.alert ? null : button;

  if (!lane) return chip;
  // The chip lane: the chip at the start, the quiet notice at the end while
  // nothing is wrong (alone at the start on phones, where the calm chip is
  // hidden). It wraps, never overflows, on a band too narrow for both.
  return (
    <div
      data-testid="ride-chip-lane"
      className={cn('flex max-w-full flex-wrap items-center justify-between gap-2', className)}
    >
      {chip}
      {!view.alert && aside}
    </div>
  );
}
