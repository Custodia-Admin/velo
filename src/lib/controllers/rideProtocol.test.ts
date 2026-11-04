import { describe, it, expect } from 'vitest';
import {
  decodeKeypad,
  pressedButtons,
  risingEdges,
  steerFrom,
  decodeBattery,
  encodeHaptic,
  encodeInfoRequest,
  fromHex,
  toHex,
  zigzagEncode,
  zigzagDecode,
  encodeVarint,
  BUTTON_MASKS,
  RIDE_ON,
  describeMessage,
  decodeFields,
  sideFromManufacturerData,
  type RideButton,
} from './rideProtocol';

/** Build a 0x23 message with nested levers (Makinolo layout). */
function keypad(map: number, levers: [number, number][] = []): Uint8Array {
  const out: number[] = [0x23, 0x08];
  encodeVarint(map >>> 0, out);
  if (levers.length) {
    const group: number[] = [];
    for (const [loc, val] of levers) {
      const press: number[] = [0x08];
      encodeVarint(loc, press);
      press.push(0x10);
      encodeVarint(zigzagEncode(val), press);
      group.push(0x0a, press.length, ...press);
    }
    out.push(0x12, group.length, ...group);
  }
  return Uint8Array.from(out);
}

describe('decodeKeypad', () => {
  it('parses the documented capture: D-pad left, levers at rest', () => {
    const msg = fromHex(
      '23 08 fe ff ff ff 0f 12 18 0a 04 08 00 10 00 0a 04 08 01 10 00 0a 04 08 02 10 00 0a 04 08 03 10 00',
    );
    const st = decodeKeypad(msg)!;
    expect(st.buttonMap).toBe(0xfffffffe);
    expect([...pressedButtons(st)]).toEqual(['left']);
    expect(st.levers).toEqual([
      { location: 0, value: 0 },
      { location: 1, value: 0 },
      { location: 2, value: 0 },
      { location: 3, value: 0 },
    ]);
  });

  it('reports nothing pressed for an all-ones map', () => {
    const st = decodeKeypad(fromHex('23 08 ff ff ff ff 0f'))!;
    expect(pressedButtons(st).size).toBe(0);
  });

  it('names every button by its mask', () => {
    for (const [name, mask] of BUTTON_MASKS) {
      const st = decodeKeypad(keypad(~mask))!;
      expect([...pressedButtons(st)]).toEqual([name]);
    }
  });

  it('handles two buttons at once', () => {
    const st = decodeKeypad(keypad(~(0x2000 | 0x2)))!;
    expect([...pressedButtons(st)].sort()).toEqual(['shiftUpR', 'up']);
  });

  it('reads negative lever values (zigzag)', () => {
    const st = decodeKeypad(keypad(0xffffffff, [[0, -87], [1, 0]]))!;
    expect(st.levers[0]).toEqual({ location: 0, value: -87 });
  });

  it('accepts the flat field-2 lever layout', () => {
    const st = decodeKeypad(fromHex('23 08 ff ff ff ff 0f 12 04 08 01 10 64'))!;
    expect(st.levers).toEqual([{ location: 1, value: 50 }]);
  });

  it('accepts repeated field-3 levers', () => {
    const st = decodeKeypad(fromHex('23 08 ff ff ff ff 0f 1a 05 08 00 10 c7 01 1a 04 08 01 10 00'))!;
    expect(st.levers).toEqual([
      { location: 0, value: -100 },
      { location: 1, value: 0 },
    ]);
  });

  it('ignores other message ids and garbage', () => {
    expect(decodeKeypad(fromHex('19 08 55'))).toBeNull();
    expect(decodeKeypad(new Uint8Array())).toBeNull();
    const truncated = decodeKeypad(fromHex('23 08 fe ff'))!;
    expect(truncated.buttonMap).toBeNull();
  });
});

describe('risingEdges', () => {
  it('fires once per press, not while held', () => {
    let prev = new Set<RideButton>();
    const fired: RideButton[] = [];
    for (const m of [0xffffffff, ~0x4000, ~0x4000, 0xffffffff, ~0x4000]) {
      const now = pressedButtons(decodeKeypad(keypad(m))!);
      fired.push(...risingEdges(prev, now));
      prev = now;
    }
    expect(fired).toEqual(['shiftDownR', 'shiftDownR']);
  });
});

describe('steerFrom', () => {
  it('is 0 at rest and inside the dead zone', () => {
    expect(steerFrom([])).toBe(0);
    expect(steerFrom([{ location: 0, value: 5 }, { location: 1, value: -8 }])).toBe(0);
  });
  it('left lever steers left, right lever right, whatever the sign', () => {
    expect(steerFrom([{ location: 0, value: -100 }])).toBe(-1);
    expect(steerFrom([{ location: 0, value: 100 }])).toBe(-1);
    expect(steerFrom([{ location: 1, value: 50 }])).toBe(0.5);
  });
  it('both levers cancel out', () => {
    expect(steerFrom([{ location: 0, value: 60 }, { location: 1, value: 60 }])).toBe(0);
  });
  it('ignores the unused locations', () => {
    expect(steerFrom([{ location: 2, value: 100 }])).toBe(0);
  });
});

describe('decodeBattery', () => {
  it('reads field 1 of a 0x19 message', () => {
    expect(decodeBattery(fromHex('19 08 55'))).toBe(85);
  });
  it('reads a nested battery field', () => {
    expect(decodeBattery(fromHex('19 0a 02 08 40'))).toBe(64);
  });
  it('rejects other ids and out-of-range values', () => {
    expect(decodeBattery(fromHex('15 08 55'))).toBeNull();
    expect(decodeBattery(fromHex('19 08 c8 01'))).toBeNull();
  });
});

describe('commands', () => {
  it('encodes the documented short buzz', () => {
    expect(toHex(encodeHaptic())).toBe('12 12 08 0a 06 08 02 10 00 18 20');
  });
  it('encodes the info request', () => {
    expect(toHex(encodeInfoRequest())).toBe('00 08 00');
    expect(toHex(encodeInfoRequest(770))).toBe('00 08 82 06');
  });
});

describe('zigzag', () => {
  it('round-trips', () => {
    for (const n of [0, 1, -1, 64, -64, 100, -100]) expect(zigzagDecode(zigzagEncode(n))).toBe(n);
  });
});

describe('left / right from manufacturer data', () => {
  it('0x08 is the left controller, 0x07 the right one', () => {
    // Real adverts: LEFT EB:5D:DC:A0:DB:F4 → 08 db f4, RIGHT DE:A6:AF:91:F7:0E → 07 f7 0e.
    expect(sideFromManufacturerData(fromHex('08 db f4'))).toBe('left');
    expect(sideFromManufacturerData(fromHex('07 f7 0e'))).toBe('right');
    expect(sideFromManufacturerData(new DataView(fromHex('08 db f4').buffer))).toBe('left');
    expect(sideFromManufacturerData(new DataView(fromHex('07 f7 0e').buffer))).toBe('right');
  });

  it('anything else is not a side', () => {
    expect(sideFromManufacturerData(fromHex('09 00 00'))).toBeNull(); // Click
    expect(sideFromManufacturerData(fromHex('02 00 00'))).toBeNull(); // Play
    expect(sideFromManufacturerData(new Uint8Array())).toBeNull();
    expect(sideFromManufacturerData(undefined)).toBeNull();
    expect(sideFromManufacturerData(null)).toBeNull();
  });
});

describe('describeMessage', () => {
  it('reads the messages the overlay shows', () => {
    expect(describeMessage('out', RIDE_ON)).toBe('RideOn handshake');
    expect(describeMessage('out', encodeHaptic())).toBe('buzz');
    expect(describeMessage('in', fromHex('15'))).toBe('idle');
    expect(describeMessage('in', fromHex('19 08 2a'))).toBe('battery 42 %');
    expect(describeMessage('in', fromHex('fe'))).toBe('taken over by another app');
    expect(describeMessage('in', fromHex('23 08 ff ff ff ff 0f'))).toBe('keys none');
    expect(describeMessage('in', fromHex('23 08 ff bf ff ff 0f'))).toBe('keys shiftUpR');
    expect(describeMessage('in', fromHex('23 08 ff ff ff ff 0f 12 06 0a 04 08 01 10 64'))).toBe('keys none · lever R 50');
    expect(describeMessage('in', fromHex('77'))).toBe('msg 0x77');
  });
});

/**
 * Frame fixtures. "capture" frames are byte-for-byte from the public protocol
 * captures (docs/devices/zwift-ride-v2.md: Makinolo, Serpentine's field
 * variant) and from the 29–31 Oct adverts; "edge" frames are built to reach
 * every parser branch (truncation, unknown wire types). The owner hardware
 * check adds real Ride V2 frames from the Controller debug log.
 */
const FRAMES: ReadonlyArray<{ kind: 'capture' | 'edge'; dir: 'in' | 'out'; hex: string; reads: string }> = [
  { kind: 'capture', dir: 'in', hex: '23 08 fe ff ff ff 0f 12 18 0a 04 08 00 10 00 0a 04 08 01 10 00 0a 04 08 02 10 00 0a 04 08 03 10 00', reads: 'keys left' },
  { kind: 'capture', dir: 'in', hex: '23 08 ff ff ff ff 0f 12 07 0a 05 08 00 10 c7 01', reads: 'keys none · lever L -100' },
  { kind: 'capture', dir: 'in', hex: '23 08 ff ff ff ff 0f 12 04 08 01 10 64', reads: 'keys none · lever R 50' },
  { kind: 'capture', dir: 'in', hex: '23 08 ff ff ff ff 0f 1a 04 08 02 10 64', reads: 'keys none · lever 2 50' },
  { kind: 'capture', dir: 'in', hex: '19 08 55', reads: 'battery 85 %' },
  { kind: 'capture', dir: 'in', hex: '15', reads: 'idle' },
  { kind: 'capture', dir: 'in', hex: '3c 0a 0a 5a 77 69 66 74 20 52 69 64 65', reads: 'device info' },
  { kind: 'capture', dir: 'in', hex: 'fe', reads: 'taken over by another app' },
  { kind: 'capture', dir: 'out', hex: '52 69 64 65 4f 6e', reads: 'RideOn handshake' },
  { kind: 'capture', dir: 'out', hex: '12 12 08 0a 06 08 02 10 00 18 20', reads: 'buzz' },
  { kind: 'capture', dir: 'out', hex: '00 08 00', reads: 'info request' },
  { kind: 'edge', dir: 'out', hex: '52 69 64 65 4f 66', reads: 'cmd 0x52' }, // RideOn length, not RideOn
  { kind: 'edge', dir: 'out', hex: '55', reads: 'cmd 0x55' },
  { kind: 'edge', dir: 'in', hex: '', reads: 'empty' },
  { kind: 'edge', dir: 'out', hex: '', reads: 'empty' },
  { kind: 'edge', dir: 'in', hex: '19', reads: 'battery ?' },
  { kind: 'edge', dir: 'in', hex: '19 10 05', reads: 'battery ?' }, // field 2 only, no battery field
  { kind: 'edge', dir: 'in', hex: '23 80', reads: 'keys none' }, // truncated tag
  { kind: 'edge', dir: 'in', hex: '42', reads: 'msg 0x42' },
];

describe('frame fixtures (every describeMessage / decoder branch)', () => {
  for (const f of FRAMES) {
    it(`${f.kind} ${f.dir} [${f.hex || 'empty'}] → ${f.reads}`, () => {
      expect(describeMessage(f.dir, fromHex(f.hex))).toBe(f.reads);
    });
  }
});

describe('decodeFields edge cases', () => {
  it('stops at a varint longer than 10 bytes', () => {
    expect(decodeFields(fromHex('08 ff ff ff ff ff ff ff ff ff ff 01'))).toEqual([]);
  });
  it('stops at a truncated value or length, and at a length past the end', () => {
    expect(decodeFields(fromHex('08'))).toEqual([]);
    expect(decodeFields(fromHex('08 80'))).toEqual([]);
    expect(decodeFields(fromHex('12'))).toEqual([]);
    expect(decodeFields(fromHex('12 05 08'))).toEqual([]);
  });
  it('skips fixed64 and fixed32 fields, stops at a group/unknown wire type', () => {
    const f = decodeFields(fromHex('09 01 02 03 04 05 06 07 08 0d 01 02 03 04 10 07 0b 08 01'));
    expect(f).toEqual([{ num: 2, wire: 0, value: 7 }]);
  });
  it('keypad: a fixed64 field before the map is skipped', () => {
    const st = decodeKeypad(fromHex('23 09 00 00 00 00 00 00 00 00 08 fd ff ff ff 0f'))!;
    expect([...pressedButtons(st)]).toEqual(['up']);
  });
});

describe('lever edge cases', () => {
  it('skips non-varint fields inside a lever and drops a lever without a location', () => {
    // {loc 1, (field 2 as bytes: ignored), value 50} then {value only}.
    const st = decodeKeypad(fromHex('23 08 ff ff ff ff 0f 1a 06 08 01 12 00 18 05 1a 02 10 64'))!;
    expect(st.levers).toEqual([{ location: 1, value: 0 }]);
  });
  it('clamps out-of-range lever values to ±100', () => {
    const st = decodeKeypad(fromHex('23 1a 05 08 00 10 f4 03'))!; // zigzag 500 → 250
    expect(st.levers).toEqual([{ location: 0, value: 100 }]);
    expect(st.buttonMap).toBeNull();
    expect(pressedButtons(st).size).toBe(0);
  });
});
