import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentThemeKey, resolveTokens, resolveTokensThemed } from './tokens';

const SPEC = {
  a: ['--x', '#111111'],
  b: ['--y', '#222222'],
} as const;

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

describe('currentThemeKey', () => {
  it("defaults to 'obsidian' when data-theme is unset", () => {
    expect(currentThemeKey()).toBe('obsidian');
  });

  it('reads the data-theme attribute', () => {
    document.documentElement.setAttribute('data-theme', 'ledger');
    expect(currentThemeKey()).toBe('ledger');
  });
});

describe('resolveTokens (fallbacks in jsdom)', () => {
  it('returns fallbacks when the CSS var is unset', () => {
    expect(resolveTokens(SPEC)).toEqual({ a: '#111111', b: '#222222' });
  });
});

describe('resolveTokensThemed cache', () => {
  // Each test uses a fresh spec object so the module-level WeakMap cache starts
  // empty for it (cache is keyed by the spec object identity).
  it('caches per theme — a repeated call for the same theme resolves once', () => {
    const spec = { a: ['--x', '#111111'] } as const;
    const spy = vi.spyOn(window, 'getComputedStyle');
    const first = resolveTokensThemed(spec);
    const second = resolveTokensThemed(spec);
    // Same object reference (cache hit) and getComputedStyle ran only once.
    expect(second).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-resolves when the theme changes, then re-caches the new theme', () => {
    const spec = { a: ['--x', '#111111'] } as const;
    const spy = vi.spyOn(window, 'getComputedStyle');
    const obsidian = resolveTokensThemed(spec); // fills 'obsidian'
    document.documentElement.setAttribute('data-theme', 'ledger');
    const ledger = resolveTokensThemed(spec); // miss → resolves 'ledger'
    const ledgerAgain = resolveTokensThemed(spec); // hit
    expect(spy).toHaveBeenCalledTimes(2); // one per distinct theme
    expect(ledger).not.toBe(obsidian);
    expect(ledgerAgain).toBe(ledger);
  });
});
