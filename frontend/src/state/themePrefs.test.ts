import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  effectiveTheme,
  THEME_PREFERENCE_OPTIONS,
  useThemePrefsStore,
  type ThemePreference,
} from './themePrefs';

const STORAGE_KEY = 'ui.themePreference.v1';

beforeEach(() => {
  localStorage.clear();
  // Reset the singleton store to its default between tests.
  useThemePrefsStore.setState({ themePreference: 'auto' });
});
afterEach(() => localStorage.clear());

describe('effectiveTheme', () => {
  it('maps auto → obsidian on live/heatmap, ledger elsewhere', () => {
    expect(effectiveTheme('auto', '/live')).toBe('obsidian');
    expect(effectiveTheme('auto', '/live/anything')).toBe('obsidian');
    expect(effectiveTheme('auto', '/heatmap')).toBe('obsidian');
    expect(effectiveTheme('auto', '/study')).toBe('ledger');
    expect(effectiveTheme('auto', '/screener')).toBe('ledger');
    expect(effectiveTheme('auto', '/settings')).toBe('ledger');
    expect(effectiveTheme('auto', '/')).toBe('ledger');
  });

  it('ignores the route for an explicit preference', () => {
    expect(effectiveTheme('obsidian', '/study')).toBe('obsidian');
    expect(effectiveTheme('ledger', '/live')).toBe('ledger');
    // toss-light is manual-only: an explicit preference is returned as-is on
    // every route, and `auto` never resolves to it (see the maps above).
    expect(effectiveTheme('toss-light', '/live')).toBe('toss-light');
    expect(effectiveTheme('toss-light', '/settings')).toBe('toss-light');
  });

  it('does not treat a look-alike prefix as a live route', () => {
    // '/liveries' must NOT match '/live'.
    expect(effectiveTheme('auto', '/liveries')).toBe('ledger');
  });
});

describe('useThemePrefsStore', () => {
  it('defaults to auto with an empty store', () => {
    expect(useThemePrefsStore.getState().themePreference).toBe('auto');
  });

  it('persists a set preference and rejects invalid values', () => {
    useThemePrefsStore.getState().setThemePreference('ledger');
    expect(useThemePrefsStore.getState().themePreference).toBe('ledger');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ themePreference: 'ledger' });

    useThemePrefsStore.getState().setThemePreference('nonsense' as ThemePreference);
    expect(useThemePrefsStore.getState().themePreference).toBe('ledger'); // unchanged
  });

  it('hydrates a valid stored value and falls back on a corrupt one', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ themePreference: 'obsidian' }));
    useThemePrefsStore.getState().hydrateFromStorage();
    expect(useThemePrefsStore.getState().themePreference).toBe('obsidian');

    localStorage.setItem(STORAGE_KEY, '{ not json');
    useThemePrefsStore.setState({ themePreference: 'ledger' });
    useThemePrefsStore.getState().hydrateFromStorage(); // no valid value → no change
    expect(useThemePrefsStore.getState().themePreference).toBe('ledger');
  });

  it('exposes exactly the four options', () => {
    expect([...THEME_PREFERENCE_OPTIONS]).toEqual(['obsidian', 'ledger', 'toss-light', 'auto']);
  });
});
