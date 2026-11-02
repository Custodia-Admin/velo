import { describe, expect, it } from 'vitest';
import {
  AVATAR_PRESETS,
  DEFAULT_AVATAR_COLORS,
  LEGACY_DEFAULT_AVATAR_COLORS,
  migrateAvatarColors,
} from './avatarConfig';

describe('v2 default rider colours', () => {
  it('defaults to the warm-atlas rider: dark kit, white helmet', () => {
    expect(DEFAULT_AVATAR_COLORS.kit).toBe('#23262d');
    expect(DEFAULT_AVATAR_COLORS.helmet).toBe('#e8e6e1');
    expect(AVATAR_PRESETS[0].colors).toBe(DEFAULT_AVATAR_COLORS);
    expect(AVATAR_PRESETS.some((p) => p.colors === LEGACY_DEFAULT_AVATAR_COLORS)).toBe(true);
  });

  it('moves an untouched old cyan default to the v2 rider', () => {
    expect(migrateAvatarColors({ ...LEGACY_DEFAULT_AVATAR_COLORS })).toEqual(DEFAULT_AVATAR_COLORS);
    expect(migrateAvatarColors({ ...LEGACY_DEFAULT_AVATAR_COLORS, kit: '#22D3EE' })).toEqual(DEFAULT_AVATAR_COLORS);
    expect(migrateAvatarColors(undefined)).toEqual(DEFAULT_AVATAR_COLORS);
  });

  it('keeps colours the rider picked', () => {
    const mine = { ...LEGACY_DEFAULT_AVATAR_COLORS, kit: '#ff0000' };
    expect(migrateAvatarColors(mine)).toEqual(mine);
    expect(migrateAvatarColors({ kit: '#00ff00' })).toEqual({ ...DEFAULT_AVATAR_COLORS, kit: '#00ff00' });
  });
});
