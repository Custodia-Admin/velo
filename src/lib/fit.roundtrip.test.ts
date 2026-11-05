import { describe, it, expect } from 'vitest';
import { buildFit } from '@/lib/fitExporter';
import type { TelemetrySample } from '@/types';

const start = Date.UTC(2026, 0, 1, 12, 0, 0);

const samples: TelemetrySample[] = Array.from({ length: 6 }, (_, i) => ({
  t: start + i * 1000,
  lat: 40.0 + i * 0.0002,
  lon: -105.0 + i * 0.0002,
  ele: 1600 + i * 3,
  distance: i * 8,
  speed: 8 + i * 0.25,
  grade: 2.5,
  power: 200 + i,
  cadence: 90,
  heartRate: 145 + i,
}));

// ─── An independent FIT reader: the oracle for the exporter ──────────────────
// Written from the FIT protocol (developer.garmin.com/fit/protocol), not from
// fitExporter.ts. The app has no FIT import any more, so it lives here.

/** FIT epoch = 1989-12-31 00:00:00 UTC, in Unix seconds. */
const FIT_EPOCH_S = 631065600;
const MESG_FILE_ID = 0;
const MESG_RECORD = 20;

function crc16(bytes: Uint8Array, end: number): number {
  const table = [
    0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
  ];
  let crc = 0;
  for (let i = 0; i < end; i++) {
    for (const nibble of [bytes[i] & 0xf, bytes[i] >> 4]) {
      const tmp = table[crc & 0xf];
      crc = ((crc >> 4) & 0x0fff) ^ tmp ^ table[nibble];
    }
  }
  return crc;
}

interface FitRecord {
  timestampS?: number;
  lat?: number;
  lon?: number;
  ele?: number;
  distance?: number;
  speed?: number;
  power?: number;
  cadence?: number;
  heartRate?: number;
}

interface DecodedFit {
  headerCrcOk: boolean;
  fileCrcOk: boolean;
  /** file_id time_created, Unix seconds. */
  timeCreatedS?: number;
  /** Global message numbers defined, in order of first appearance. */
  messages: number[];
  records: FitRecord[];
}

function decodeFit(buffer: ArrayBuffer): DecodedFit {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const headerSize = bytes[0];
  expect(headerSize).toBe(14);
  expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('.FIT');
  const dataSize = view.getUint32(4, true);
  expect(bytes.length).toBe(headerSize + dataSize + 2);

  const out: DecodedFit = {
    headerCrcOk: view.getUint16(12, true) === crc16(bytes, 12),
    fileCrcOk: view.getUint16(headerSize + dataSize, true) === crc16(bytes, headerSize + dataSize),
    messages: [],
    records: [],
  };

  const defs = new Map<number, { le: boolean; global: number; fields: { num: number; size: number }[] }>();
  let pos = headerSize;
  const end = headerSize + dataSize;
  while (pos < end) {
    const header = bytes[pos++];
    expect(header & 0x80).toBe(0); // no compressed-timestamp records
    const local = header & 0x0f;
    if (header & 0x40) {
      expect(header & 0x20).toBe(0); // no developer fields
      const le = bytes[pos + 1] === 0;
      const global = view.getUint16(pos + 2, le);
      const count = bytes[pos + 4];
      pos += 5;
      const fields = [];
      for (let i = 0; i < count; i++, pos += 3) fields.push({ num: bytes[pos], size: bytes[pos + 1] });
      defs.set(local, { le, global, fields });
      if (!out.messages.includes(global)) out.messages.push(global);
      continue;
    }
    const def = defs.get(local);
    expect(def, `data message for undefined local id ${local}`).toBeDefined();
    const { le, global, fields } = def!;
    const rec: FitRecord = {};
    for (const f of fields) {
      if (global === MESG_FILE_ID && f.num === 4) out.timeCreatedS = view.getUint32(pos, le) + FIT_EPOCH_S;
      if (global === MESG_RECORD) {
        switch (f.num) {
          case 253: rec.timestampS = view.getUint32(pos, le) + FIT_EPOCH_S; break;
          case 0: rec.lat = (view.getInt32(pos, le) / 2 ** 31) * 180; break;
          case 1: rec.lon = (view.getInt32(pos, le) / 2 ** 31) * 180; break;
          case 2: rec.ele = view.getUint16(pos, le) / 5 - 500; break;
          case 5: rec.distance = view.getUint32(pos, le) / 100; break;
          case 6: rec.speed = view.getUint16(pos, le) / 1000; break;
          case 7: rec.power = view.getUint16(pos, le); break;
          case 4: rec.cadence = bytes[pos]; break;
          case 3: rec.heartRate = bytes[pos]; break;
        }
      }
      pos += f.size;
    }
    if (global === MESG_RECORD) out.records.push(rec);
  }
  expect(pos).toBe(end);
  return out;
}

describe('FIT export → decode round-trip', () => {
  it('rejects an empty sample set', () => {
    expect(() => buildFit({ startTime: start, samples: [] })).toThrow();
  });

  it('writes a valid activity file: both CRCs, the file_id time, every message type', async () => {
    const fit = decodeFit(await buildFit({ startTime: start, samples }).arrayBuffer());
    expect(fit.headerCrcOk).toBe(true);
    expect(fit.fileCrcOk).toBe(true);
    expect(fit.timeCreatedS).toBe(start / 1000);
    // file_id, session, lap, record, activity.
    expect([...fit.messages].sort((a, b) => a - b)).toEqual([0, 18, 19, 20, 34]);
  });

  it('re-decodes the same telemetry the encoder wrote', async () => {
    const fit = decodeFit(await buildFit({ startTime: start, samples }).arrayBuffer());
    expect(fit.records).toHaveLength(samples.length);

    fit.records.forEach((r, i) => {
      const src = samples[i];
      expect(r.timestampS).toBe(src.t / 1000);
      // Semicircle quantization is ~8.4e-8°; allow a generous 1e-4° envelope.
      expect(r.lat).toBeCloseTo(src.lat, 4);
      expect(r.lon).toBeCloseTo(src.lon, 4);
      // Altitude stored at 1/5 m resolution.
      expect(Math.abs(r.ele! - src.ele)).toBeLessThan(0.25);
      // Distance stored at cm resolution.
      expect(Math.abs(r.distance! - src.distance)).toBeLessThan(0.01);
      // Speed stored at mm/s resolution.
      expect(Math.abs(r.speed! - src.speed)).toBeLessThan(0.01);
      // Integer channels survive exactly.
      expect(r.power).toBe(src.power);
      expect(r.cadence).toBe(src.cadence);
      expect(r.heartRate).toBe(src.heartRate);
    });
  });
});
