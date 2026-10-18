import type { LiveMAConfig } from '../state/liveIndicatorsPersistence';
import { colorContrast } from '../live/indicators/colorContrast';
import { currentThemeKey } from './tokens';

// Keep the assigned hue stable; only its shade follows the theme. Both chart
// strokes and legend text use these concrete colors (canvas cannot use CSS vars).
const SHADES: Record<string, readonly [light: string, dark: string]> = {
  '#EC4899': ['#BE185D', '#F472B6'],
  '#3B82F6': ['#1D4ED8', '#60A5FA'],
  '#F97316': ['#C2410C', '#FB923C'],
  '#22C55E': ['#15803D', '#4ADE80'],
  '#6B7280': ['#374151', '#CBD5E1'],
  '#06B6D4': ['#0E7490', '#22D3EE'],
  '#EAB308': ['#A16207', '#FACC15'],
  '#94A3B8': ['#475569', '#94A3B8'],
};
const BACKGROUNDS: Record<string, string> = {
  obsidian: '#121216', 'obsidian-pro': '#171A20', 'toss-dark': '#17171C',
  ledger: '#FDFCF8', 'ledger-studio': '#FFFEFA', 'toss-light': '#FFFFFF',
};

/** Missing mode is a legacy, explicitly stored color. Never rewrite it on theme changes. */
export function resolveMaColor(config: Pick<LiveMAConfig, 'color' | 'colorMode'>, theme = currentThemeKey()): string {
  if (config.colorMode !== 'auto') return config.color;
  const dark = theme === 'obsidian' || theme === 'obsidian-pro' || theme === 'toss-dark';
  const shades = SHADES[config.color.toUpperCase()];
  if (shades) return shades[dark ? 1 : 0];

  // Switching a custom hue to automatic keeps that hue too. Mix toward white
  // or black only as far as needed for readable legend text and chart lines.
  const background = BACKGROUNDS[theme] ?? '#FFFFFF';
  if (!/^#[\da-f]{6}$/i.test(config.color)) return dark ? '#CBD5E1' : '#374151';
  const rgb = [1, 3, 5].map(offset => parseInt(config.color.slice(offset, offset + 2), 16));
  for (let step = 0; step <= 20; step++) {
    const color = '#' + rgb.map(channel => Math.round(channel + ((dark ? 255 : 0) - channel) * step / 20).toString(16).padStart(2, '0')).join('');
    if ((colorContrast(color, background) ?? 0) >= 4.5) return color.toUpperCase();
  }
  return dark ? '#FFFFFF' : '#000000';
}
