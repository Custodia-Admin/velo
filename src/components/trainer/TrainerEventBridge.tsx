import { useEffect } from 'react';

import { useRideStore } from '@/stores/rideStore';
import {
  onBatteryLevel,
  onControlPointError,
  onDisconnect,
  onReconnect,
  onTrainerData,
} from '@/lib/ftms';
import { reconnectGrantedTrainer, trainerLost } from '@/lib/trainerReconnect';
import { LOW_BATTERY_PCT, formatBattery } from '@/lib/controllers/battery';

/**
 * The trainer is gone after the automatic retries. The toast carries the
 * Reconnect tap (the ride view has no other trainer Reconnect control); a
 * tap that fails brings it back so the rider can try again once the
 * trainer is awake. Sticky (`durationMs` null) while it is the only way back.
 */
function pushTrainerLostToast(message: string, durationMs: number | null): void {
  useRideStore.getState().pushToast({
    id: 'trainer-connection',
    kind: 'error',
    title: "Couldn't reconnect after several attempts",
    message,
    action: {
      label: 'Reconnect',
      onClick: () => {
        void reconnectGrantedTrainer().then((ok) => {
          // Back by another route meanwhile (wake, chooser): nothing to offer.
          if (!ok && useRideStore.getState().connection === 'disconnected') {
            pushTrainerLostToast('Still no trainer. Wait for its light, then tap Reconnect again.', null);
          }
        });
      },
    },
    durationMs,
  });
}

/**
 * Mount once at app root. Subscribes to the FTMS module's event hooks and
 * fans them out into the Zustand store + toast queue. Owns no UI of its own
 * (returns null) so it can live next to the Toaster and Router.
 *
 * Effects:
 *   - trainer data       → store.ingestTrainerData
 *   - battery level      → store.setBatteryLevel + low-battery toast
 *   - unexpected drop    → store.setConnection('reconnecting') + toast
 *                          (only inside a ride: outside one ftms holds the
 *                          trainer for a tap and reports phase 'held')
 *   - reconnect phases   → store.setReconnect + toasts (success / failure /
 *                          held for a tap)
 *   - control-point errs → toasts so the user knows resistance is misbehaving
 */
export function TrainerEventBridge(): null {
  // Pull actions imperatively from the store; we don't need re-renders here.
  useEffect(() => {
    const ingest = useRideStore.getState().ingestTrainerData;
    onTrainerData(ingest);
  }, []);

  useEffect(() => {
    onBatteryLevel((level) => {
      const setBatteryLevel = useRideStore.getState().setBatteryLevel;
      const pushToast = useRideStore.getState().pushToast;
      setBatteryLevel(level);
      if (level <= LOW_BATTERY_PCT) {
        pushToast({
          id: 'trainer-battery-low',
          kind: 'warning',
          title: `Trainer battery low (${formatBattery(level)})`,
          message:
            "If it dies mid-ride you'll lose resistance control. Plug in if you can.",
          durationMs: 8_000,
        });
      }
    });
  }, []);

  useEffect(() => {
    onDisconnect(({ unexpected }) => {
      const st = useRideStore.getState();
      if (!unexpected) {
        st.setConnection('disconnected', { deviceName: null });
        return;
      }
      // Unexpected → we expect a reconnect attempt next. Show as
      // reconnecting; the reconnect listener will refine the message.
      st.setConnection('reconnecting', {
        error: 'Trainer dropped — trying to reconnect…',
      });
      st.pushToast({
        id: 'trainer-connection',
        kind: 'warning',
        title: 'Trainer disconnected',
        message: 'Trying to reconnect automatically…',
        durationMs: null,
      });
    });
  }, []);

  useEffect(() => {
    onReconnect((evt) => {
      const st = useRideStore.getState();
      switch (evt.phase) {
        case 'start':
          st.setReconnect(0, evt.maxAttempts);
          break;
        case 'attempt':
          st.setReconnect(evt.attempt, evt.maxAttempts);
          st.pushToast({
            id: 'trainer-connection',
            kind: 'warning',
            title: 'Reconnecting to trainer',
            message: `Attempt ${evt.attempt} of ${evt.maxAttempts}…`,
            durationMs: null,
          });
          break;
        case 'success':
          st.setConnection('connected', { deviceName: st.deviceName });
          st.setReconnect(0, 0);
          st.pushToast({
            id: 'trainer-connection',
            kind: 'success',
            title: 'Trainer reconnected',
            message: 'Resistance control is back online.',
            durationMs: 4_000,
          });
          break;
        case 'failed': {
          const lostName = st.deviceName;
          st.setConnection('disconnected', {
            deviceName: null,
            error: 'Auto-reconnect failed',
            code: 'reconnect-failed',
          });
          st.setReconnect(0, 0);
          // Fall back to demo so the ride doesn't freeze with zero speed.
          if (st.mode === 'trainer') st.setMode('demo');
          // Reconnect on its own when it wakes up (during the ride), and say
          // so only once the browser has actually agreed to watch for it.
          // The toast carries the Reconnect tap: the ride view has no other
          // trainer Reconnect control (and on Linux nothing watches for it).
          void trainerLost(lostName).then((wakes) => {
            pushTrainerLostToast(
              wakes
                ? 'Switched to Demo Mode so the ride keeps going. Pedal once to wake the trainer: it reconnects by itself.'
                : 'Switched to Demo Mode so the ride keeps going. Pedal once to wake the trainer, then tap Reconnect.',
              wakes ? 10_000 : null,
            );
          });
          break;
        }
        case 'held': {
          // No ride open: nothing reconnects on its own. One tap brings it back.
          const lostName = st.deviceName;
          st.setConnection('disconnected', { deviceName: null });
          st.setReconnect(0, 0);
          if (st.mode === 'trainer') st.setMode('demo');
          void trainerLost(lostName);
          st.pushToast({
            id: 'trainer-connection',
            kind: 'warning',
            title: 'Trainer disconnected',
            message: 'Pedal once to wake it, then tap Reconnect.',
            durationMs: 8_000,
          });
          break;
        }
      }
    });
  }, []);

  useEffect(() => {
    onControlPointError((err) => {
      const st = useRideStore.getState();
      st.pushToast({
        id: `ftms-cp-${err.opcode}`,
        kind: err.resultCode === 0x05 ? 'error' : 'warning',
        title: 'Trainer rejected a command',
        message: err.message,
        durationMs: 6_000,
      });
    });
  }, []);

  return null;
}
