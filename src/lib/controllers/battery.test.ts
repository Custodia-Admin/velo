import { describe, it, expect } from 'vitest';
import {
  BATTERY_LEVEL_UUID,
  BATTERY_SERVICE_UUID,
  LOW_BATTERY_PCT,
  batteryBand,
  batteryLabel,
  formatBattery,
  parseBatteryLevel,
  watchBattery,
  type BatteryServer,
} from './battery';

class FakeLevel extends EventTarget {
  value: DataView | undefined;
  notifying = false;
  properties: { notify: boolean } = { notify: true };
  constructor(
    private byte: number | null,
    private readonly opts: { readFails?: boolean; notifyFails?: boolean } = {},
  ) {
    super();
  }
  async readValue() {
    if (this.opts.readFails || this.byte === null) throw new Error('read refused');
    return new DataView(Uint8Array.of(this.byte).buffer);
  }
  async startNotifications() {
    if (this.opts.notifyFails) throw new Error('no notify');
    this.notifying = true;
    return this;
  }
  push(bytes: number[]) {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function server(ch: FakeLevel | null): BatteryServer & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    async getPrimaryService(uuid) {
      asked.push(uuid);
      if (!ch || uuid !== BATTERY_SERVICE_UUID) throw Object.assign(new Error('no service'), { name: 'NotFoundError' });
      return {
        async getCharacteristic(c) {
          asked.push(c);
          if (c !== BATTERY_LEVEL_UUID) throw new Error('no char');
          return ch as unknown as BluetoothRemoteGATTCharacteristic;
        },
      };
    },
  };
}

describe('parseBatteryLevel', () => {
  it('reads the one uint8 from a DataView or bytes', () => {
    expect(parseBatteryLevel(new DataView(Uint8Array.of(76).buffer))).toBe(76);
    expect(parseBatteryLevel(Uint8Array.of(0))).toBe(0);
    expect(parseBatteryLevel(Uint8Array.of(100, 7))).toBe(100);
  });
  it('rejects empty, missing and out-of-spec (>100) values', () => {
    expect(parseBatteryLevel(null)).toBeNull();
    expect(parseBatteryLevel(undefined)).toBeNull();
    expect(parseBatteryLevel(new Uint8Array())).toBeNull();
    expect(parseBatteryLevel(Uint8Array.of(101))).toBeNull();
    expect(parseBatteryLevel(Uint8Array.of(0xff))).toBeNull();
  });
});

describe('display helpers', () => {
  it('bands: low at ≤ 20 %, medium to 70 %, then full', () => {
    expect(batteryBand(0)).toBe('low');
    expect(batteryBand(LOW_BATTERY_PCT)).toBe('low');
    expect(batteryBand(21)).toBe('medium');
    expect(batteryBand(70)).toBe('medium');
    expect(batteryBand(71)).toBe('full');
  });
  it('formats with a space before %, and says "low" to screen readers', () => {
    expect(formatBattery(76)).toBe('76 %');
    expect(formatBattery(75.6)).toBe('76 %');
    expect(batteryLabel(76)).toBe('Battery 76 %');
    expect(batteryLabel(12)).toBe('Battery 12 %, low');
  });
});

describe('watchBattery (standard Battery Service 0x180F)', () => {
  it('reads, then follows notifications; repeats are not re-reported; stop() detaches', async () => {
    const ch = new FakeLevel(85);
    const seen: number[] = [];
    const w = await watchBattery(server(ch), (p) => seen.push(p));
    expect(w?.level).toBe(85);
    expect(ch.notifying).toBe(true);
    ch.push([84]);
    ch.push([84]);
    ch.push([200]); // invalid: ignored
    ch.push([]);
    expect(seen).toEqual([85, 84]);
    w!.stop();
    ch.push([50]);
    expect(seen).toEqual([85, 84]);
    expect(w!.level).toBe(84);
  });

  it('no Battery Service: null, never throws', async () => {
    expect(await watchBattery(server(null), () => undefined)).toBeNull();
  });

  it('a refused read still follows notifications', async () => {
    const ch = new FakeLevel(null, { readFails: true });
    const seen: number[] = [];
    const w = await watchBattery(server(ch), (p) => seen.push(p));
    expect(w?.level).toBeNull();
    ch.push([60]);
    expect(seen).toEqual([60]);
  });

  it('notifications missing or refused: the first reading still counts', async () => {
    const quiet = new FakeLevel(40);
    quiet.properties = { notify: false };
    const seen: number[] = [];
    const w = await watchBattery(server(quiet), (p) => seen.push(p));
    expect(quiet.notifying).toBe(false);
    expect(seen).toEqual([40]);
    w!.stop(); // no listener to remove: still fine

    const refusing = new FakeLevel(30, { notifyFails: true });
    const w2 = await watchBattery(server(refusing), () => undefined);
    expect(w2?.level).toBe(30);
  });

  it('only reads (never writes) the battery characteristic', async () => {
    const ch = new FakeLevel(70) as FakeLevel & { writeValue?: unknown };
    let writes = 0;
    ch.writeValue = () => {
      writes++;
    };
    await watchBattery(server(ch), () => undefined);
    expect(writes).toBe(0);
  });
});
