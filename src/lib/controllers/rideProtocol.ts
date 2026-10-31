/**
 * Wire protocol of the Ride V2 handlebar controllers. Pure: no navigator, no
 * Bluetooth, so it runs in node tests.
 *
 * Written from the public protocol notes in docs/devices/zwift-ride-v2.md
 * (Makinolo's write-ups, cross-checked against chrisperkles/serpentine, MIT).
 */

/** Controller service on firmware from Jan 2025 on (16-bit FC82). */
export const RIDE_SERVICE = '0000fc82-0000-1000-8000-00805f9b34fb';
/** Same service on older firmware. */
export const RIDE_SERVICE_LEGACY = '00000001-19ca-4651-86e5-fa29dcdd09d1';
/** Notifications: buttons, battery, idle ticks. */
export const RIDE_ASYNC = '00000002-19ca-4651-86e5-fa29dcdd09d1';
/** We write commands here. */
export const RIDE_SYNC_RX = '00000003-19ca-4651-86e5-fa29dcdd09d1';
/** Replies to our commands (indications). */
export const RIDE_SYNC_TX = '00000004-19ca-4651-86e5-fa29dcdd09d1';

export const BATTERY_SERVICE = 0x180f;
export const BATTERY_LEVEL = 0x2a19;

/** Bluetooth SIG company id in the advertising data. */
export const RIDE_COMPANY_ID = 0x094a;
/** Advertised names start with this. */
export const RIDE_NAME_PREFIX = 'Zwift';

/** First manufacturer-data byte (after the company id): which Ride controller. */
export const RIDE_TYPE_RIGHT = 0x07;
export const RIDE_TYPE_LEFT = 0x08;

export type ControllerSide = 'left' | 'right';

/**
 * Side of a Ride controller from its advertised manufacturer data (company
 * 0x094A, payload without the company id). Only the left one reliably
 * forwards button presses. Null for anything else (Click, Play, garbage).
 */
export function sideFromManufacturerData(data: DataView | Uint8Array | null | undefined): ControllerSide | null {
  if (!data || data.byteLength === 0) return null;
  const first = data instanceof DataView ? data.getUint8(0) : data[0];
  if (first === RIDE_TYPE_LEFT) return 'left';
  if (first === RIDE_TYPE_RIGHT) return 'right';
  return null;
}

export const MSG_KEYPAD = 0x23;
export const MSG_BATTERY = 0x19;
export const MSG_IDLE = 0x15;
export const MSG_DEVICE_INFO = 0x3c;
export const MSG_TAKEN_OVER = 0xfe;

/** ASCII "RideOn": the whole handshake on the Ride (no encryption). */
export const RIDE_ON = Uint8Array.of(0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e);

export type RideButton =
  | 'left' | 'up' | 'right' | 'down'
  | 'a' | 'b' | 'y' | 'z'
  | 'shiftUpL' | 'shiftDownL' | 'hoodL' | 'powerL'
  | 'shiftUpR' | 'shiftDownR' | 'hoodR' | 'powerR';

/** Bit masks in ButtonMap. Inverse logic on the wire: a cleared bit = pressed. */
export const BUTTON_MASKS: ReadonlyArray<readonly [RideButton, number]> = [
  ['left', 0x00001],
  ['up', 0x00002],
  ['right', 0x00004],
  ['down', 0x00008],
  ['a', 0x00010],
  ['b', 0x00020],
  ['y', 0x00040],
  ['z', 0x00100],
  ['shiftUpL', 0x00200],
  ['shiftDownL', 0x00400],
  ['hoodL', 0x00800],
  ['powerL', 0x01000],
  ['shiftUpR', 0x02000],
  ['shiftDownR', 0x04000],
  ['hoodR', 0x10000],
  ['powerR', 0x20000],
];

// ---- protobuf (proto2 wire format, just what we need) -------------------

export interface PbField {
  num: number;
  wire: number;
  /** Varint value (wire type 0). */
  value: number;
  /** Payload (wire type 2). */
  bytes?: Uint8Array;
}

/** Decode one level of protobuf fields. Stops quietly at malformed input. */
export function decodeFields(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  const varint = (): number | null => {
    let v = 0;
    let mul = 1;
    for (let n = 0; n < 10; n++) {
      if (i >= buf.length) return null;
      const b = buf[i++];
      v += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return v;
      mul *= 128;
    }
    return null;
  };
  while (i < buf.length) {
    const tag = varint();
    if (tag === null) break;
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      const v = varint();
      if (v === null) break;
      out.push({ num, wire, value: v });
    } else if (wire === 2) {
      const len = varint();
      if (len === null || i + len > buf.length) break;
      out.push({ num, wire, value: len, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

export function encodeVarint(n: number, out: number[]): void {
  let v = Math.max(0, Math.floor(n));
  while (v >= 128) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function zigzagDecode(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}

export function zigzagEncode(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function varintField(num: number, v: number, out: number[]): void {
  out.push(num * 8);
  encodeVarint(v, out);
}

function messageField(num: number, body: number[], out: number[]): void {
  out.push(num * 8 + 2);
  encodeVarint(body.length, out);
  out.push(...body);
}

// ---- keypad --------------------------------------------------------------

export interface AnalogLever {
  /** 0 = left lever, 1 = right lever (2 and 3 are unused today). */
  location: number;
  /** -100..100. */
  value: number;
}

export interface KeypadStatus {
  buttonMap: number | null;
  levers: AnalogLever[];
}

function leverFrom(bytes: Uint8Array): AnalogLever | null {
  let location: number | null = null;
  let value = 0;
  for (const f of decodeFields(bytes)) {
    if (f.wire !== 0) continue;
    if (f.num === 1) location = f.value;
    else if (f.num === 2) value = zigzagDecode(f.value);
  }
  return location === null ? null : { location, value: Math.max(-100, Math.min(100, value)) };
}

/**
 * Parse a 0x23 keypad message. Three lever layouts are seen in the field:
 *   field 2 → repeated field 1 → {location, value}   (Makinolo capture)
 *   field 2 → {location, value}                       (Serpentine "variant")
 *   field 3 → {location, value}, repeated
 * All are accepted. Returns null for any other message id.
 */
export function decodeKeypad(msg: Uint8Array): KeypadStatus | null {
  if (msg.length === 0 || msg[0] !== MSG_KEYPAD) return null;
  const out: KeypadStatus = { buttonMap: null, levers: [] };
  for (const f of decodeFields(msg.subarray(1))) {
    if (f.num === 1 && f.wire === 0) {
      out.buttonMap = f.value;
    } else if ((f.num === 2 || f.num === 3) && f.bytes) {
      const inner = decodeFields(f.bytes);
      const nested = inner.filter((g) => g.num === 1 && g.wire === 2 && g.bytes);
      if (nested.length > 0) {
        for (const g of nested) {
          const lever = leverFrom(g.bytes!);
          if (lever) out.levers.push(lever);
        }
      } else {
        const lever = leverFrom(f.bytes);
        if (lever) out.levers.push(lever);
      }
    }
  }
  return out;
}

/** Buttons held in this status (bit cleared = pressed). */
export function pressedButtons(status: KeypadStatus): Set<RideButton> {
  const out = new Set<RideButton>();
  if (status.buttonMap === null) return out;
  for (const [name, mask] of BUTTON_MASKS) {
    if (Math.floor(status.buttonMap / mask) % 2 === 0) out.add(name);
  }
  return out;
}

/** Buttons pressed now that were not pressed before. */
export function risingEdges(prev: ReadonlySet<RideButton>, next: ReadonlySet<RideButton>): RideButton[] {
  const out: RideButton[] = [];
  for (const b of next) if (!prev.has(b)) out.push(b);
  return out;
}

/** Below this the lever is treated as at rest (out of 100). */
export const LEVER_DEADZONE = 12;

/**
 * Steering input -1 (full left) .. 1 (full right) from the two levers.
 * Uses magnitude only, so it does not depend on the lever's sign convention.
 */
export function steerFrom(levers: readonly AnalogLever[]): number {
  let left = 0;
  let right = 0;
  for (const l of levers) {
    const mag = Math.abs(l.value);
    if (mag < LEVER_DEADZONE) continue;
    if (l.location === 0) left = Math.max(left, mag);
    else if (l.location === 1) right = Math.max(right, mag);
  }
  return Math.max(-1, Math.min(1, (right - left) / 100));
}

// ---- battery -------------------------------------------------------------

/** Battery percent from a 0x19 message, else null. */
export function decodeBattery(msg: Uint8Array): number | null {
  if (msg.length === 0 || msg[0] !== MSG_BATTERY) return null;
  const fields = decodeFields(msg.subarray(1));
  let f = fields.find((x) => x.num === 1 && x.wire === 0);
  if (!f) {
    const nested = fields.find((x) => x.num === 1 && x.bytes);
    f = nested?.bytes ? decodeFields(nested.bytes).find((x) => x.num === 1 && x.wire === 0) : undefined;
  }
  return f && f.value >= 0 && f.value <= 100 ? f.value : null;
}

// ---- commands to the controller -----------------------------------------

export interface HapticParams {
  param1: number;
  param2: number;
  pattern: number;
}

/** Short buzz, the pattern other apps use for shift feedback. */
export const SHORT_BUZZ: HapticParams = { param1: 2, param2: 0, pattern: 0x20 };

/** 0x12 PlayCommand { CommandContents(2) { CommandParameters(1) { 1, 2, HapticPattern(3) } } }. */
export function encodeHaptic(p: HapticParams = SHORT_BUZZ): Uint8Array {
  const params: number[] = [];
  varintField(1, p.param1, params);
  varintField(2, p.param2, params);
  varintField(3, p.pattern, params);
  const contents: number[] = [];
  messageField(1, params, contents);
  const out: number[] = [0x12];
  messageField(2, contents, out);
  return Uint8Array.from(out);
}

/** 0x00 request for device information (reply 0x3c on Sync TX). */
export function encodeInfoRequest(dataId = 0): Uint8Array {
  const out: number[] = [0x00];
  varintField(1, dataId, out);
  return Uint8Array.from(out);
}

/**
 * One-line reading of a message for the field debug overlay, e.g.
 * "keys shiftUpR · lever R 50", "battery 42 %", "idle", "RideOn handshake".
 */
export function describeMessage(dir: 'in' | 'out', msg: Uint8Array): string {
  if (msg.length === 0) return 'empty';
  if (dir === 'out') {
    if (msg.length === RIDE_ON.length && msg.every((b, i) => b === RIDE_ON[i])) return 'RideOn handshake';
    if (msg[0] === 0x12) return 'buzz';
    if (msg[0] === 0x00) return 'info request';
    return `cmd 0x${msg[0].toString(16).padStart(2, '0')}`;
  }
  switch (msg[0]) {
    case MSG_KEYPAD: {
      const status = decodeKeypad(msg);
      if (!status) return 'keys ?';
      const keys = [...pressedButtons(status)];
      const levers = status.levers
        .filter((l) => Math.abs(l.value) >= LEVER_DEADZONE)
        .map((l) => `lever ${l.location === 0 ? 'L' : l.location === 1 ? 'R' : l.location} ${l.value}`);
      return [keys.length ? `keys ${keys.join(' ')}` : 'keys none', ...levers].join(' · ');
    }
    case MSG_BATTERY: {
      const pct = decodeBattery(msg);
      return pct === null ? 'battery ?' : `battery ${pct} %`;
    }
    case MSG_IDLE:
      return 'idle';
    case MSG_DEVICE_INFO:
      return 'device info';
    case MSG_TAKEN_OVER:
      return 'taken over by another app';
    default:
      return `msg 0x${msg[0].toString(16).padStart(2, '0')}`;
  }
}

/** Hex dump for the debug log, e.g. "23 08 fe ff ff ff 0f". */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Parse "23 08 fe..." back to bytes (tests, pasted captures). */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
