/**
 * Devices page heart-rate row: the same BLE Heart Rate client and store
 * wiring as the legacy SensorConnect (lib/bleSensors + rideStore), rendered
 * from devicesView.heartRateRow. Optional; nothing without Web Bluetooth.
 */

import { useCallback, useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { DeviceRow } from '@/components/velo/DeviceRow';
import { heartRateRow, type HeartRateActionId } from '@/components/velo/devicesView';
import {
  BleSensorError,
  connectHr,
  disconnectHr,
  hrDeviceName,
  onHrData,
  onHrStatus,
} from '@/lib/bleSensors';
import { useRideStore } from '@/stores/rideStore';

export function HeartRateRow() {
  const status = useRideStore((s) => s.hrSensorStatus);
  const deviceName = useRideStore((s) => s.hrSensorDeviceName);
  const bpm = useRideStore((s) => s.hrSensorValue);
  const setHrSensorStatus = useRideStore((s) => s.setHrSensorStatus);
  const ingestHrSensorData = useRideStore((s) => s.ingestHrSensorData);
  const pushToast = useRideStore((s) => s.pushToast);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);

  // BLE callbacks → store. Store-only on purpose and left registered when
  // the page closes, so a strap paired here keeps streaming during the ride.
  useEffect(() => {
    onHrStatus((s) => setHrSensorStatus(s, hrDeviceName()));
    onHrData((v) => ingestHrSensorData(v));
  }, [setHrSensorStatus, ingestHrSensorData]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      await connectHr();
      pushToast({
        kind: 'success',
        title: 'Heart rate monitor connected',
        message: hrDeviceName() ?? 'Live HR is streaming.',
        durationMs: 3_500,
      });
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to connect HR monitor',
        code: err instanceof BleSensorError ? err.code : 'unknown',
      });
      setHrSensorStatus('error', null);
    }
  }, [setHrSensorStatus, pushToast]);

  const handleDisconnect = useCallback(async () => {
    await disconnectHr();
    setHrSensorStatus('disconnected', null);
    pushToast({ kind: 'info', title: 'Heart rate monitor disconnected', durationMs: 2_500 });
  }, [setHrSensorStatus, pushToast]);

  const view = heartRateRow({
    status,
    deviceName,
    bpm,
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
  });

  const onAction = (id: HeartRateActionId) => {
    if (id === 'pair') void handleConnect();
    else void handleDisconnect();
  };

  return (
    <DeviceRow
      icon={Heart}
      view={view}
      onAction={onAction}
      quietAction={view.action?.id === 'disconnect'}
      testId="device-heart-rate"
    />
  );
}
