import type { Config } from 'tailwindcss';

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
        up: 'var(--up)',
        down: 'var(--down)',
        grid: 'var(--grid)',
        'heat-lo': 'var(--heat-lo)',
        'heat-hi': 'var(--heat-hi)',
      },
      fontFamily: {
        ui: 'var(--font-ui)',
        sans: 'var(--font-ui)',
        mono: 'var(--font-mono)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      fontSize: {
        xs: 'var(--text-xs)',
        sm: 'var(--text-sm)',
        base: 'var(--text-base)',
        md: 'var(--text-md)',
        lg: 'var(--text-lg)',
        xl: 'var(--text-xl)',
        '2xl': 'var(--text-2xl)',
      },
      spacing: {
        '2xs': 'var(--space-2xs)',
        xs: 'var(--space-xs)',
        sm: 'var(--space-sm)',
        md: 'var(--space-md)',
        lg: 'var(--space-lg)',
        xl: 'var(--space-xl)',
        '2xl': 'var(--space-2xl)',
        '3xl': 'var(--space-3xl)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        full: 'var(--radius-full)',
      },
    },
  },
  plugins: [],
} satisfies Config;
