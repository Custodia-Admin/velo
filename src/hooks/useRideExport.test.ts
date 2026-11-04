/**
 * Pure parts of useRideExport: the .FIT file name. No network, no React.
 */
import { describe, expect, it } from 'vitest';

import { fitFileName } from './useRideExport';

describe('names', () => {
  it('builds a filesystem-safe FIT file name', () => {
    expect(fitFileName('Tiber river park', Date.UTC(2026, 10, 1, 15, 30, 5))).toBe(
      'Tiber_river_park_2026-11-01T15-30-05.fit',
    );
    expect(fitFileName(undefined, Date.UTC(2026, 10, 1))).toBe('velo_2026-11-01T00-00-00.fit');
  });
});
