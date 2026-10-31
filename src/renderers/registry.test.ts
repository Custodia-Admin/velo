import { describe, expect, it } from 'vitest';
import { AVAILABLE_RENDERERS, RENDERER_LOADERS, rendererFor } from './registry';
import { DEFAULT_SETTINGS } from '@/stores/settingsStore';

describe('renderer registry', () => {
  it('ships the photoreal (Cesium) renderer behind a lazy loader', () => {
    expect(typeof RENDERER_LOADERS.photoreal).toBe('function');
    expect(AVAILABLE_RENDERERS.has('photoreal')).toBe(true);
  });

  it("the default 'world' setting draws with photoreal until the world renderer ships (P1.4)", () => {
    expect(DEFAULT_SETTINGS.renderer).toBe('world');
    if (RENDERER_LOADERS.world === null) {
      expect(rendererFor('world')).toBe('photoreal');
    } else {
      expect(rendererFor('world')).toBe('world');
    }
  });

  it('a rider who picked photoreal gets photoreal', () => {
    expect(rendererFor('photoreal')).toBe('photoreal');
  });
});
