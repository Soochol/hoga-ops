import type { Config } from 'tailwindcss';
import { TAILWIND_THEME } from './src/styles/tokens.generated';

/**
 * Size/spacing/layout/radius tokens are generated from design-tokens.ts —
 * see src/styles/tokens.generated.ts. Regenerate via `npm run gen:tokens`.
 *
 * Color/font-family tokens stay here (manually edited) because:
 *   - Colors don't participate in the density dial.
 *   - Font-family tokens reference CSS variables that map to OS-aware stacks.
 *   - DESIGN.md treats both as a separate concern from sizing.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-card': 'var(--bg-card)',
        'bg-subtle': 'var(--bg-subtle)',
        'bg-input': 'var(--bg-input)',
        'bg-input-hover': 'var(--bg-input-hover)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        fg: 'var(--fg)',
        'fg-dim': 'var(--fg-dim)',
        'fg-dimmer': 'var(--fg-dimmer)',
        accent: 'var(--accent)',
        'accent-fg': 'var(--accent-fg)',
        'accent-shade': 'var(--accent-shade)',
        success: 'var(--success)',
        error:   'var(--error)',
        'price-up':   'var(--price-up)',
        'price-down': 'var(--price-down)',
        grid: 'var(--grid)',
        'heat-lo': 'var(--heat-lo)',
        'heat-hi': 'var(--heat-hi)',
        'tint-selection':  'var(--tint-selection)',
        'tint-success':    'var(--tint-success)',
        'tint-error':      'var(--tint-error)',
        'tint-price-up':   'var(--tint-price-up)',
        'tint-price-down': 'var(--tint-price-down)',
      },
      fontFamily: {
        ui: 'var(--font-ui)',
        sans: 'var(--font-ui)',
        mono: 'var(--font-mono)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      // Generated tokens (size, spacing, layout, radius) — see comment above.
      ...TAILWIND_THEME,
    },
  },
  plugins: [],
} satisfies Config;
