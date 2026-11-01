import { describe, expect, it } from 'vitest';
import { resolveLayout } from './tvLayout';

describe('resolveLayout (interim TV rule until P3.3)', () => {
  it('is the default layout on a laptop', () => {
    expect(resolveLayout({ query: null, stored: null, tvScreen: false })).toBe('default');
  });

  it('switches to TV on a wide screen without a fine pointer', () => {
    expect(resolveLayout({ query: null, stored: null, tvScreen: true })).toBe('tv');
  });

  it('lets ?layout= override the screen, and remembers it for the session', () => {
    expect(resolveLayout({ query: 'tv', stored: null, tvScreen: false })).toBe('tv');
    expect(resolveLayout({ query: 'default', stored: 'tv', tvScreen: true })).toBe('default');
    expect(resolveLayout({ query: null, stored: 'tv', tvScreen: false })).toBe('tv');
    expect(resolveLayout({ query: null, stored: 'default', tvScreen: true })).toBe('default');
  });

  it('ignores unknown values', () => {
    expect(resolveLayout({ query: 'huge', stored: 'x', tvScreen: false })).toBe('default');
  });
});
