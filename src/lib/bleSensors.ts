/**
 * Web Bluetooth client for a standalone BLE heart-rate strap.
 *
 * Follows the same pattern as ftms.ts:
 *   - module-level device/server/characteristic handles
 *   - subscription callbacks pushed from outside (the Zustand store wires them)
 *   - transparent GATT reconnect with capped exponential back-off
 *   - user-initiated disconnect flag so we don't treat a clean tear-down as
 *     an unexpected drop
 *
 * Supported profiles
 * ──────────────────
 * Heart Rate Monitor
 *   Service  : 0x180D  Heart Rate Service
 *   Char     : 0x2A37  Heart Rate Measurement
 *   Parsing  : flags byte bit-0 → 8-bit (0) or 16-bit (1) HR value field
 *
 * Reference specs
 * ───────────────
 *   Bluetooth SIG GATT: https://www.bluetooth.com/specifications/gatt/
 *   Heart Rate Service 1.0: 0x180D / 0x2A37
 */

import { detectBluetoothSupport } from './bluetoothSupport';

// ---------------------------------------------------------------------------
// UUIDs
// ---------------------------------------------------------------------------

export const HR_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

// ---------------------------------------------------------------------------
// Reconnect tuning (same as ftms.ts)
// ---------------------------------------------------------------------------

const RECONNECT_MAX_ATTEMPTS = 4;
const RECONNECT_BASE_DELAY_MS = 600;
const RECONNECT_MAX_DELAY_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type BleSensorErrorCode =
  | 'unsupported'
  | 'insecure-context'
  | 'no-device-selected'
  | 'no-device-found'
  | 'gatt-connect-failed'
  | 'service-not-found'
  | 'unknown';

export class BleSensorError extends Error {
  readonly code: BleSensorErrorCode;
  readonly cause?: unknown;
  constructor(code: BleSensorErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'BleSensorError';
    this.code = code;
    this.cause = cause;
  }
}

function classifyChooserError(err: unknown): BleSensorError {
  if (err instanceof BleSensorError) return err;
  if (err instanceof DOMException || err instanceof Error) {
    const name = (err as DOMException).name ?? '';
    const msg = err.message ?? '';
    if (name === 'NotFoundError') {
      if (/user cancelled|cancelled/i.test(msg))
        return new BleSensorError('no-device-selected', 'You closed the device chooser.', err);
      return new BleSensorError('no-device-found', 'No compatible sensor was found.', err);
    }
    if (name === 'SecurityError' || /permission/i.test(msg))
      return new BleSensorError('unsupported', 'Bluetooth permission was denied.', err);
    if (name === 'NotSupportedError')
      return new BleSensorError('unsupported', 'Web Bluetooth is not supported in this browser.', err);
    if (name === 'NetworkError')
      return new BleSensorError('gatt-connect-failed', 'Sensor dropped during connection setup.', err);
  }
  return new BleSensorError('unknown', err instanceof Error ? err.message : 'Unknown Bluetooth error', err);
}

// ---------------------------------------------------------------------------
// Reconnect loop
// ---------------------------------------------------------------------------

async function runReconnectLoop(
  dev: BluetoothDevice,
  setupSession: (dev: BluetoothDevice) => Promise<void>,
  isUserDisconnect: () => boolean,
  onReconnect: (phase: 'attempt' | 'success' | 'failed', attempt: number) => void,
  onGiveUp: () => void,
): Promise<void> {
  for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
    if (isUserDisconnect()) return;
    onReconnect('attempt', attempt);
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1));
    await sleep(delay);
    if (isUserDisconnect()) return;
    try {
      await setupSession(dev);
      onReconnect('success', attempt);
      return;
    } catch {
      console.warn(`[BLE] reconnect attempt ${attempt} failed`);
    }
  }
  onReconnect('failed', RECONNECT_MAX_ATTEMPTS);
  onGiveUp();
}

// ===========================================================================
// HEART RATE CLIENT
// ===========================================================================

export type HrListener = (bpm: number) => void;
export type HrStatusListener = (status: SensorConnectionStatus) => void;

export type SensorConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

interface HrState {
  device: BluetoothDevice | null;
  server: BluetoothRemoteGATTServer | null;
  char: BluetoothRemoteGATTCharacteristic | null;
  dataListener: HrListener | null;
  statusListener: HrStatusListener | null;
  userDisconnect: boolean;
  reconnectInFlight: boolean;
}

const hr: HrState = {
  device: null,
  server: null,
  char: null,
  dataListener: null,
  statusListener: null,
  userDisconnect: false,
  reconnectInFlight: false,
};

export function onHrData(listener: HrListener | null): void {
  hr.dataListener = listener;
}

export function onHrStatus(listener: HrStatusListener | null): void {
  hr.statusListener = listener;
}

export function hrDeviceName(): string | null {
  return hr.device?.name ?? null;
}

/**
 * Prompt the user to pick a Heart Rate Monitor and start streaming.
 * Throws `BleSensorError` with a discriminable `code` on failure.
 */
export async function connectHr(): Promise<void> {
  const support = detectBluetoothSupport();
  if (!support.apiPresent) {
    throw new BleSensorError('unsupported', support.reason ?? 'Web Bluetooth is not available.');
  }
  if (!support.secureContext) {
    throw new BleSensorError('insecure-context', 'Web Bluetooth requires HTTPS or localhost.');
  }

  hr.userDisconnect = false;
  hr.statusListener?.('connecting');

  try {
    hr.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE_UUID] }],
      optionalServices: [HR_SERVICE_UUID],
    });
  } catch (err) {
    hr.statusListener?.('error');
    throw classifyChooserError(err);
  }

  hr.device.addEventListener('gattserverdisconnected', handleHrGattDisconnect);

  try {
    await setupHrSession(hr.device);
    hr.statusListener?.('connected');
  } catch (err) {
    hr.statusListener?.('error');
    void disconnectHr().catch(() => undefined);
    throw err;
  }
}

async function setupHrSession(dev: BluetoothDevice): Promise<void> {
  if (!dev.gatt) throw new BleSensorError('gatt-connect-failed', 'Device has no GATT server.');

  try {
    hr.server = await dev.gatt.connect();
  } catch (err) {
    throw new BleSensorError('gatt-connect-failed', 'Could not open GATT connection to HR monitor.', err);
  }

  let service: BluetoothRemoteGATTService;
  try {
    service = await hr.server.getPrimaryService(HR_SERVICE_UUID);
  } catch (err) {
    throw new BleSensorError('service-not-found', 'Heart Rate Service (0x180D) not found on this device.', err);
  }

  try {
    hr.char = await service.getCharacteristic(HR_MEASUREMENT_UUID);
    await hr.char.startNotifications();
    hr.char.addEventListener('characteristicvaluechanged', handleHrNotification);
  } catch (err) {
    throw new BleSensorError('service-not-found', 'Heart Rate Measurement characteristic could not be subscribed.', err);
  }
}

export async function disconnectHr(): Promise<void> {
  hr.userDisconnect = true;
  try {
    if (hr.char) {
      hr.char.removeEventListener('characteristicvaluechanged', handleHrNotification);
    }
    if (hr.device) {
      hr.device.removeEventListener('gattserverdisconnected', handleHrGattDisconnect);
    }
    if (hr.server?.connected) hr.server.disconnect();
  } finally {
    hr.char = null;
    hr.server = null;
    hr.device = null;
  }
  hr.statusListener?.('disconnected');
}

function handleHrNotification(event: Event): void {
  const target = event.target as BluetoothRemoteGATTCharacteristic;
  if (!target.value) return;
  const bpm = parseHrMeasurement(target.value);
  if (bpm !== null) hr.dataListener?.(bpm);
}

function handleHrGattDisconnect(): void {
  hr.char = null;
  if (hr.userDisconnect) {
    hr.server = null;
    hr.device = null;
    return;
  }
  hr.statusListener?.('reconnecting');
  if (!hr.device || hr.reconnectInFlight) return;
  hr.reconnectInFlight = true;
  void runReconnectLoop(
    hr.device,
    setupHrSession,
    () => hr.userDisconnect,
    (phase, attempt) => {
      if (phase === 'success') {
        hr.statusListener?.('connected');
      } else if (phase === 'failed') {
        hr.statusListener?.('error');
        hr.server = null;
        hr.device = null;
      } else {
        // attempt
        void attempt; // used by console.warn in runReconnectLoop
      }
    },
    () => {
      hr.server = null;
      hr.device = null;
    },
  ).finally(() => {
    hr.reconnectInFlight = false;
  });
}

/**
 * Parse Heart Rate Measurement (0x2A37).
 *
 * Flags byte (octet 0):
 *   bit 0 → 0 = HR value is uint8, 1 = HR value is uint16 LE
 *   bit 1–2 → sensor contact status
 *   bit 3 → energy expended present
 *   bit 4 → RR-interval present
 */
export function parseHrMeasurement(view: DataView): number | null {
  if (view.byteLength < 2) return null;
  const flags = view.getUint8(0);
  const is16bit = (flags & 0x01) !== 0;
  if (is16bit) {
    if (view.byteLength < 3) return null;
    return view.getUint16(1, true);
  }
  return view.getUint8(1);
}
