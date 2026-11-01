/**
 * Standard BLE Battery Service (0x180F, Battery Level 0x2A19) for every
 * device Velo pairs: the handlebar controllers and the trainer. Read once,
 * then follow notifications when the device offers them. Read-only: nothing
 * here writes to a device.
 *
 * Parsing and the display bands are pure so they run in node tests.
 */

/** 16-bit UUIDs, accepted by Web Bluetooth as numbers. */
export const BATTERY_SERVICE_UUID = 0x180f;
export const BATTERY_LEVEL_UUID = 0x2a19;

/** At or below this the panels and the in-ride chip call the battery low. */
export const LOW_BATTERY_PCT = 20;

/**
 * Battery percent from a Battery Level value (one uint8, 0..100), else null.
 * Values above 100 are invalid per the spec and are dropped, not clamped.
 */
export function parseBatteryLevel(value: DataView | Uint8Array | null | undefined): number | null {
  if (!value || value.byteLength < 1) return null;
  const pct = value instanceof DataView ? value.getUint8(0) : value[0];
  return pct <= 100 ? pct : null;
}

export type BatteryBand = 'low' | 'medium' | 'full';

/** Which battery glyph to draw: low (≤ 20 %), medium (≤ 70 %), full. */
export function batteryBand(pct: number): BatteryBand {
  if (pct <= LOW_BATTERY_PCT) return 'low';
  if (pct <= 70) return 'medium';
  return 'full';
}

/** "76 %" — Velo writes a space before the percent sign everywhere. */
export function formatBattery(pct: number): string {
  return `${Math.round(pct)} %`;
}

/** Accessible name, e.g. "Battery 76 %, low". */
export function batteryLabel(pct: number): string {
  return `Battery ${formatBattery(pct)}${pct <= LOW_BATTERY_PCT ? ', low' : ''}`;
}

/** The slice of a GATT server the battery watch needs (injectable in tests). */
export interface BatteryServer {
  getPrimaryService(uuid: BluetoothServiceUUID): Promise<{
    getCharacteristic(uuid: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
  }>;
}

export interface BatteryWatch {
  /** Last reading, or null when the device sent nothing usable yet. */
  readonly level: number | null;
  /** Stop listening (the characteristic itself stays as it is). */
  stop(): void;
}

/**
 * Read the battery level and follow its notifications. Resolves null when
 * the device has no Battery Service (many don't). Never throws: a battery
 * reading is never worth failing a pairing for.
 */
export async function watchBattery(
  server: BatteryServer,
  onLevel: (pct: number) => void,
): Promise<BatteryWatch | null> {
  let ch: BluetoothRemoteGATTCharacteristic;
  try {
    const svc = await server.getPrimaryService(BATTERY_SERVICE_UUID);
    ch = await svc.getCharacteristic(BATTERY_LEVEL_UUID);
  } catch {
    return null;
  }
  let level: number | null = null;
  let stopped = false;
  const take = (v: DataView | null | undefined) => {
    const pct = parseBatteryLevel(v);
    if (pct === null || stopped || pct === level) return;
    level = pct;
    onLevel(pct);
  };
  const onChange = () => take(ch.value);
  try {
    take(await ch.readValue());
  } catch {
    /* some firmware refuses the read and only notifies */
  }
  let listening = false;
  try {
    if (ch.properties?.notify !== false) {
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', onChange);
      listening = true;
    }
  } catch {
    /* notifications are optional */
  }
  return {
    get level() {
      return level;
    },
    stop() {
      stopped = true;
      if (listening) ch.removeEventListener('characteristicvaluechanged', onChange);
    },
  };
}
