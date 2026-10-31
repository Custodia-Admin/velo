import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDERER,
  RENDERER_KINDS,
  isRendererKind,
  resolveRenderer,
  type RendererKind,
} from './renderer';

const set = (...k: RendererKind[]) => new Set<RendererKind>(k);

describe('renderer kinds', () => {
  it("defaults to the token-free 'world' renderer", () => {
    expect(DEFAULT_RENDERER).toBe('world');
    expect(RENDERER_KINDS).toEqual(['world', 'photoreal']);
  });

  it('validates persisted values', () => {
    expect(isRendererKind('world')).toBe(true);
    expect(isRendererKind('photoreal')).toBe(true);
    for (const bad of ['cesium', '', null, undefined, 3, {}]) expect(isRendererKind(bad)).toBe(false);
  });
});

describe('resolveRenderer', () => {
  it('uses the preferred renderer when this build ships it', () => {
    expect(resolveRenderer('world', set('world', 'photoreal'))).toBe('world');
    expect(resolveRenderer('photoreal', set('world', 'photoreal'))).toBe('photoreal');
  });

  it('falls back to the other renderer so a ride never starts without a world', () => {
    expect(resolveRenderer('world', set('photoreal'))).toBe('photoreal');
    expect(resolveRenderer('photoreal', set('world'))).toBe('world');
  });

  it('returns the preference when nothing is available (caller renders nothing)', () => {
    expect(resolveRenderer('world', set())).toBe('world');
  });
});
