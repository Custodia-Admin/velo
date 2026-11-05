/**
 * geocode() maps Nominatim rows to results. What this pins: each result keeps
 * Nominatim's `addresstype` as `kind`, so Home's search list can tell apart
 * two places with one display name (Perugia the county and Perugia the city).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { geocode } from './geocoder';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('geocode', () => {
  it('keeps what each place is (addresstype → kind) and the short name', async () => {
    const rows = [
      { place_id: 1, display_name: 'Perugia, Umbria, Italy', lat: '43.107', lon: '12.403', type: 'administrative', addresstype: 'county', importance: 0.72 },
      { place_id: 2, display_name: 'Perugia, Umbria, Italy', lat: '43.112', lon: '12.389', type: 'administrative', addresstype: 'city', importance: 0.66 },
    ];
    vi.stubGlobal('navigator', { language: 'en' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => rows })));
    const out = await geocode('Perugia (kind test)');
    expect(out.map((r) => [r.shortName, r.kind])).toEqual([['Perugia', 'county'], ['Perugia', 'city']]);
  });
});
