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
