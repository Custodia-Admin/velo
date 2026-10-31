import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __setBluetoothForTests,
  pairRideController,
  disconnectRideController,
  reconnectRideController,
  buzzRideController,
  onControllerButton,
  controllerDebug,
  detectControllerSide,
  getDebugEntries,
  SIDE_WATCH_MS,
  SILENT_AFTER_MS,
  DEBUG_LINES,
} from './rideController';
import { controllerPhase } from './controllerView';
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

/** Adds watchAdvertisements that emits one advert with the given type byte. */
function advertising(d: FakeDevice, typeByte: number | null, delayMs = 50): { watched: number; aborted: boolean } {
  const probe = { watched: 0, aborted: false };
  (d as unknown as { watchAdvertisements: (o?: { signal?: AbortSignal }) => Promise<void> }).watchAdvertisements =
    async (o) => {
      probe.watched++;
      o?.signal?.addEventListener('abort', () => {
        probe.aborted = true;
      });
      if (typeByte === null) return;
      setTimeout(() => {
        const ev = Object.assign(new Event('advertisementreceived'), {
          manufacturerData: new Map([[0x094a, new DataView(Uint8Array.of(typeByte, 0xdb, 0xf4).buffer)]]),
        });
        d.dispatchEvent(ev);
      }, delayMs);
    };
  return probe;
}

const phase = () => controllerPhase(st());

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

describe('left / right', () => {
  it('reads LEFT (0x08) from the advert before connecting', async () => {
    const probe = advertising(device, 0x08);
    await pairRideController();
    expect(probe.watched).toBe(1);
    expect(probe.aborted).toBe(true);
    expect(st().side).toBe('left');
    expect(phase()).toBe('waiting');
  });

  it('flags RIGHT (0x07) and offers the other controller until a press arrives', async () => {
    advertising(device, 0x07);
    await pairRideController();
    expect(st().side).toBe('right');
    expect(st().status).toBe('connected');
    expect(phase()).toBe('rightSide');
    // Some firmware does forward presses through the right unit: then it is fine.
    device.async_.notify('23 08 ff ff ff ff 0f');
    expect(phase()).toBe('live');
  });

  it('times out to unknown when no advert arrives', async () => {
    vi.useFakeTimers();
    advertising(device, null);
    const p = detectControllerSide(device as unknown as BluetoothDevice);
    await vi.advanceTimersByTimeAsync(SIDE_WATCH_MS + 10);
    expect(await p).toBe('unknown');
  });

  it('ignores adverts from other device types (Click = 0x09)', async () => {
    vi.useFakeTimers();
    advertising(device, 0x09);
    const p = detectControllerSide(device as unknown as BluetoothDevice);
    await vi.advanceTimersByTimeAsync(SIDE_WATCH_MS + 10);
    expect(await p).toBe('unknown');
  });

  it('falls back to unsupported without watchAdvertisements, and still connects', async () => {
    await pairRideController();
    expect(st().side).toBe('unsupported');
    expect(st().status).toBe('connected');
  });

  it('a rejected watchAdvertisements is unsupported, not an error', async () => {
    (device as unknown as { watchAdvertisements: () => Promise<void> }).watchAdvertisements = async () => {
      throw new Error('flag off');
    };
    await pairRideController();
    expect(st().side).toBe('unsupported');
    expect(st().status).toBe('connected');
  });
});

describe('state machine', () => {
  it('connecting → connected (waiting) → silent → reconnect → live', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const unsub = useControllerStore.subscribe(() => {
      const p = phase();
      if (seen[seen.length - 1] !== p) seen.push(p);
    });
    await pairRideController();
    expect(phase()).toBe('waiting');
    await vi.advanceTimersByTimeAsync(SILENT_AFTER_MS - 100);
    expect(phase()).toBe('waiting');
    await vi.advanceTimersByTimeAsync(200);
    expect(phase()).toBe('silent');
    await reconnectRideController();
    expect(phase()).toBe('waiting');
    device.async_.notify('23 08 ff bf ff ff 0f'); // shiftUpR → keypad = input
    expect(phase()).toBe('live');
    unsub();
    expect(seen).toEqual(['pairing', 'waiting', 'silent', 'pairing', 'waiting', 'live']);
  });

  it('silent → reconnect with the service gone → locked', async () => {
    vi.useFakeTimers();
    await pairRideController();
    await vi.advanceTimersByTimeAsync(SILENT_AFTER_MS + 10);
    expect(phase()).toBe('silent');
    device.hasRideService = false;
    await reconnectRideController();
    expect(phase()).toBe('locked');
  });

  it('a drop goes reconnecting, then back to connected', async () => {
    vi.useFakeTimers();
    await pairRideController();
    device.drop();
    expect(phase()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1100);
    expect(st().status).toBe('connected');
  });

  it('disconnect clears side, buzz and input', async () => {
    advertising(device, 0x08);
    await pairRideController();
    device.async_.notify('23 08 ff ff ff ff 0f');
    await disconnectRideController();
    expect(st()).toMatchObject({ side: null, buzz: null, inputSeen: false, status: 'idle' });
    expect(phase()).toBe('none');
  });
});

describe('confirm buzz', () => {
  it('buzzes once right after the handshake and reports it', async () => {
    await pairRideController();
    expect(device.rx.writes).toEqual(['52 69 64 65 4f 6e', '12 12 08 0a 06 08 02 10 00 18 20']);
    expect(st().buzz).toBe('ok');
  });

  it('a failed buzz is not fatal', async () => {
    let n = 0;
    device.rx.writeValue = async (b: BufferSource) => {
      if (n++ > 0) throw new Error('GATT write failed');
      device.rx.writes.push(toHex(new Uint8Array(b as ArrayBuffer)));
    };
    await pairRideController();
    expect(st().status).toBe('connected');
    expect(st().buzz).toBe('failed');
  });
});

describe('debug overlay lines', () => {
  it('keeps the last lines, folds repeats and notes the gear a press caused', async () => {
    await pairRideController();
    const off = onControllerButton((b) => {
      if (b === 'shiftUpR') st().shift(1);
    });
    for (let i = 0; i < 3; i++) device.async_.notify('15');
    device.async_.notify('23 08 ff bf ff ff 0f'); // shiftUpR (0x2000)
    off();
    const lines = getDebugEntries();
    expect(lines.length).toBeLessThanOrEqual(DEBUG_LINES);
    const idle = lines.find((l) => l.hex === '15');
    expect(idle).toMatchObject({ note: 'idle', count: 3, dir: 'in' });
    const press = lines[lines.length - 1];
    expect(press.note).toBe('keys shiftUpR · press shiftUpR→gearHarder · gear 6→7');
    for (let i = 0; i < 20; i++) device.async_.notify(`19 08 ${(10 + i).toString(16)}`);
    expect(getDebugEntries()).toHaveLength(DEBUG_LINES);
    expect(getDebugEntries()[DEBUG_LINES - 1].note).toBe('battery 29 %');
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
