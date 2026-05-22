import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveTokens } from '../../src/util/tokens';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tokensCSS = readFileSync(
  resolve(__dirname, '../../src/styles/tokens.css'),
  'utf-8',
);

describe('resolveTokens', () => {
  let originalGetComputedStyle: typeof globalThis.getComputedStyle;

  beforeEach(() => {
    originalGetComputedStyle = globalThis.getComputedStyle;
  });
  afterEach(() => {
    globalThis.getComputedStyle = originalGetComputedStyle;
    vi.unstubAllGlobals();
  });

  it('returns CSS values when defined', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: (name: string) =>
        ({ '--up': '#22C55E', '--down': '#F43F5E' })[name] ?? '',
    }) as unknown as typeof globalThis.getComputedStyle;

    expect(resolveTokens({ up: ['--up', '#fff'], down: ['--down', '#000'] })).toEqual({
      up: '#22C55E',
      down: '#F43F5E',
    });
  });

  it('falls back when CSS var is empty', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: () => '',
    }) as unknown as typeof globalThis.getComputedStyle;

    expect(resolveTokens({ accent: ['--accent', '#14B8A6'] })).toEqual({
      accent: '#14B8A6',
    });
  });

  it('trims whitespace from CSS value', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: () => '  #13131C  ',
    }) as unknown as typeof globalThis.getComputedStyle;

    expect(resolveTokens({ bgCard: ['--bg-card', '#000'] })).toEqual({
      bgCard: '#13131C',
    });
  });

  it('returns fallbacks verbatim when document is absent (SSR)', () => {
    // vitest+jsdom provides document; simulate SSR by stubbing it away.
    const realDoc = globalThis.document;
    // @ts-expect-error — deleting a defined global in a test.
    delete globalThis.document;
    try {
      expect(
        resolveTokens({
          up: ['--up', '#22C55E'],
          down: ['--down', '#F43F5E'],
        }),
      ).toEqual({ up: '#22C55E', down: '#F43F5E' });
    } finally {
      globalThis.document = realDoc;
    }
  });
});

describe('tokens.css declarations', () => {
  it('sets :root font-size to 20px (single density dial)', () => {
    expect(tokensCSS).toMatch(/font-size:\s*20px/);
  });

  it('declares spacing tokens in rem', () => {
    expect(tokensCSS).toMatch(/--space-md:\s*0\.75rem/);
    expect(tokensCSS).toMatch(/--space-sm:\s*0\.5rem/);
    expect(tokensCSS).toMatch(/--space-lg:\s*1rem/);
  });

  it('declares layout tokens in rem', () => {
    expect(tokensCSS).toMatch(/--nav-w:\s*13\.125rem/);
    expect(tokensCSS).toMatch(/--sidebar-w:\s*20rem/);
    expect(tokensCSS).toMatch(/--h-tab:\s*2rem/);
    expect(tokensCSS).toMatch(/--h-tab-secondary:\s*1\.875rem/);
  });

  it('declares the --text-badge token for hierarchical badges', () => {
    expect(tokensCSS).toMatch(/--text-badge:\s*0\.53125rem/);
  });

  it('keeps existing --text-* rem values unchanged (they auto-scale via root)', () => {
    expect(tokensCSS).toMatch(/--text-base:\s*0\.8125rem/);
    expect(tokensCSS).toMatch(/--text-xs:\s*0\.65625rem/);
  });
});
