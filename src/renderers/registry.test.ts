import { describe, expect, it } from 'vitest';
import { AVAILABLE_RENDERERS, RENDERER_LOADERS, rendererFor } from './registry';
import { DEFAULT_SETTINGS } from '@/stores/settingsStore';

describe('renderer registry', () => {
  it('ships both renderers behind lazy loaders', () => {
    expect(typeof RENDERER_LOADERS.photoreal).toBe('function');
    expect(typeof RENDERER_LOADERS.world).toBe('function');
    expect(AVAILABLE_RENDERERS).toEqual(new Set(['world', 'photoreal']));
  });

  it("the default 'world' setting draws with the world renderer where a world covers the route", () => {
    expect(DEFAULT_SETTINGS.renderer).toBe('world');
    expect(rendererFor('world')).toBe('world');
    expect(rendererFor('world', true)).toBe('world');
  });

  it('routes without a world (or a world that failed) ride photoreal', () => {
    expect(rendererFor('world', false)).toBe('photoreal');
  });

  it('a rider who picked photoreal gets photoreal', () => {
    expect(rendererFor('photoreal')).toBe('photoreal');
    expect(rendererFor('photoreal', false)).toBe('photoreal');
  });
});
