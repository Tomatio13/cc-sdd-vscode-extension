import { describe, expect, it } from 'vitest';
import { accentColors, isAccentName } from '../src/map/accent';

describe('work map accents', () => {
  it('accepts only the palette names', () => {
    expect(isAccentName('mono')).toBe(true);
    expect(isAccentName('teal')).toBe(true);
    expect(isAccentName('blue')).toBe(false);
    expect(isAccentName('vscode')).toBe(false);
  });

  it('falls back to monochrome for an unknown or retired value', () => {
    expect(accentColors('blue', 'dark')).toEqual(accentColors('mono', 'dark'));
    expect(accentColors('vscode', 'light')).toEqual(accentColors('mono', 'light'));
  });

  it('keeps the accent and the active tone distinct', () => {
    for (const name of ['mono', 'teal', 'amber'] as const) {
      expect(accentColors(name, 'dark').accent).not.toBe(accentColors(name, 'dark').active);
      expect(accentColors(name, 'light').accent).not.toBe(accentColors(name, 'light').active);
    }
  });
});
