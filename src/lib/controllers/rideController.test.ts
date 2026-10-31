import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __setBluetoothForTests,
  pairRideController,
  disconnectRideController,
  reconnectRideController,
  buzzRideController,
  onControllerButton,
  controllerDebug,
  SILENT_AFTER_MS,
} from './rideController';
import {
  RIDE_ASYNC,
  RIDE_SERVICE,
  RIDE_SYNC_RX,
  RIDE_SYNC_TX,
  BATTERY_SERVICE,
  BATTERY_LEVEL,
  fromHex,
  toHex,
  type RideButton,
} from './rideProtocol';
import { useControllerStore } from '@/stores/controllerStore';

// ---- minimal Web Bluetooth fakes ----------------------------------------

class FakeChar extends EventTarget {
  value: DataView | undefined;
  writes: string[] = [];
  properties = { write: true, writeWithoutResponse: true } as BluetoothCharacteristicProperties;
  constructor(private readonly readByte?: number) {
    super();
  }
  async startNotifications() {
    return this;
  }
  async writeValue(b: BufferSource) {
    this.writes.push(toHex(new Uint8Array(b as ArrayBuffer)));
  }
  async writeValueWithoutResponse(b: BufferSource) {
    return this.writeValue(b);
  }
  async readValue() {
    return new DataView(Uint8Array.of(this.readByte ?? 0).buffer);
  }
  notify(hex: string) {
    const bytes = fromHex(hex);
    this.value = new DataView(bytes.buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class FakeDevice extends EventTarget {
  name = 'Zwift SF2';
  async_ = new FakeChar();
  rx = new FakeChar();
  tx = new FakeChar();
  bas = new FakeChar(77);
  hasRideService = true;
  failConnect = false;
  gatt: {
    connected: boolean;
    connect: () => Promise<unknown>;
    disconnect: () => void;
    getPrimaryService: (u: BluetoothServiceUUID) => Promise<unknown>;
  };
  constructor() {
    super();
    const chars: Record<string, FakeChar> = {
      [RIDE_ASYNC]: this.async_,
      [RIDE_SYNC_RX]: this.rx,
      [RIDE_SYNC_TX]: this.tx,
    };
    const rideService = { getCharacteristic: async (u: string) => chars[u] };
    const batteryService = {
      getCharacteristic: async (u: number) => {
        if (u !== BATTERY_LEVEL) throw new Error('no char');
        return this.bas;
      },
    };
    const gatt = {
      connected: false,
      connect: async () => {
        if (this.failConnect) throw Object.assign(new Error('fail'), { name: 'NetworkError' });
        gatt.connected = true;
        return gatt;
      },
      disconnect: () => {
        gatt.connected = false;
      },
      getPrimaryService: async (u: BluetoothServiceUUID) => {
        if (u === RIDE_SERVICE && this.hasRideService) return rideService;
        if (u === BATTERY_SERVICE) return batteryService;
        throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      },
    };
    this.gatt = gatt;
  }
  drop() {
    this.gatt.connected = false;
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

let device: FakeDevice;
let chooserError: Error | null;

beforeEach(() => {
  device = new FakeDevice();
  chooserError = null;
  __setBluetoothForTests({
    requestDevice: async () => {
      if (chooserError) throw chooserError;
      return device as unknown as BluetoothDevice;
    },
  });
});

afterEach(async () => {
  await disconnectRideController();
  __setBluetoothForTests(null);
  useControllerStore.getState().resetGear();
  vi.useRealTimers();
});

const st = () => useControllerStore.getState();

describe('pairing', () => {
  it('show-all fallback opens an unfiltered chooser', async () => {
    const seen: RequestDeviceOptions[] = [];
    __setBluetoothForTests({
      requestDevice: async (o) => {
        seen.push(o);
        return device as unknown as BluetoothDevice;
      },
    });
    await pairRideController({ showAllDevices: true });
    expect(seen[0]).toMatchObject({ acceptAllDevices: true });
    expect((seen[0] as { filters?: unknown }).filters).toBeUndefined();
    expect(st().status).toBe('connected');
  });

  it('handshakes with RideOn and reads the battery', async () => {
    await pairRideController();
    expect(st().status).toBe('connected');
    expect(device.rx.writes[0]).toBe('52 69 64 65 4f 6e');
    expect(st().battery).toBe(77);
    expect(st().deviceName).toBe('Zwift SF2');
  });

  it('reports locked when the controller service is hidden, and never writes', async () => {
    device.hasRideService = false;
    await pairRideController();
    expect(st().status).toBe('locked');
    expect(device.rx.writes).toEqual([]);
    // the late disconnect event must not turn "locked" into "reconnecting"
    device.drop();
    expect(st().status).toBe('locked');
  });

  it('try again after unlocking reconnects without the chooser', async () => {
    device.hasRideService = false;
    await pairRideController();
    device.hasRideService = true;
    await reconnectRideController();
    expect(st().status).toBe('connected');
  });

  it('a cancelled chooser goes back to idle', async () => {
    chooserError = Object.assign(new Error('cancelled'), { name: 'NotFoundError' });
    await pairRideController();
    expect(st().status).toBe('idle');
  });

  it('a failed connection shows a plain error', async () => {
    device.failConnect = true;
    await pairRideController();
    expect(st().status).toBe('error');
    expect(st().errorMessage).toMatch(/wake them/);
  });
});

describe('messages', () => {
  it('fires each button once per press and tracks steering', async () => {
    await pairRideController();
    const got: RideButton[] = [];
    const off = onControllerButton((b) => got.push(b));
    device.async_.notify('23 08 ff ff fe ff 0f'); // shiftDownR (0x4000) held
    device.async_.notify('23 08 ff ff fe ff 0f'); // still held
    device.async_.notify('23 08 ff ff ff ff 0f');
    device.async_.notify('23 08 ff ff ff ff 0f 12 06 0a 04 08 01 10 64'); // right lever 50
    off();
    expect(got).toEqual(['shiftDownR']);
    expect(st().steer).toBe(0.5);
    device.async_.notify('23 08 ff ff ff ff 0f');
    expect(st().steer).toBe(0);
  });

  it('updates the battery from 0x19 messages', async () => {
    await pairRideController();
    device.async_.notify('19 08 2a');
    expect(st().battery).toBe(42);
  });

  it('keeps a hex log for the hardware session', async () => {
    await pairRideController();
    device.async_.notify('15');
    const lines = controllerDebug.lines();
    expect(lines.some((l) => l.endsWith('out 52 69 64 65 4f 6e'))).toBe(true);
    expect(lines.some((l) => l.endsWith('in 15'))).toBe(true);
  });

  it('flags silent controls when nothing arrives after the handshake', async () => {
    vi.useFakeTimers();
    await pairRideController();
    await vi.advanceTimersByTimeAsync(SILENT_AFTER_MS + 10);
    expect(st().silent).toBe(true);
    device.async_.notify('15');
    expect(st().silent).toBe(false);
  });

  it('another app taking over is reported', async () => {
    await pairRideController();
    device.async_.notify('fe');
    expect(st().status).toBe('error');
  });
});

describe('drops', () => {
  it('reconnects after an unexpected drop, without duplicate button events', async () => {
    vi.useFakeTimers();
    await pairRideController();
    device.drop();
    expect(st().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1100);
    expect(st().status).toBe('connected');
    const got: RideButton[] = [];
    const off = onControllerButton((b) => got.push(b));
    device.async_.notify('23 08 fd ff ff ff 0f'); // up
    off();
    expect(got).toEqual(['up']);
  });

  it('gives up as asleep after the retries', async () => {
    vi.useFakeTimers();
    await pairRideController();
    device.failConnect = true;
    device.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(st().status).toBe('asleep');
  });

  it('keeps the gear through a short drop, neutral once asleep', async () => {
    const { activeGear } = await import('@/stores/controllerStore');
    vi.useFakeTimers();
    await pairRideController();
    st().shift(2);
    device.failConnect = true;
    device.drop();
    expect(activeGear()).toBe(8);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(activeGear()).toBe(6);
  });
});

describe('buzz', () => {
  it('writes the haptic command only while connected', async () => {
    buzzRideController(); // nothing paired: no throw
    await pairRideController();
    buzzRideController();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(device.rx.writes).toContain('12 12 08 0a 06 08 02 10 00 18 20');
  });
});
