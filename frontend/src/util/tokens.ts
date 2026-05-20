/**
 * Resolve DESIGN.md CSS custom properties off `:root` to concrete strings.
 *
 * Why this exists: `lightweight-charts` paints to a `<canvas>` and the chart
 * config options (`upColor`, `textColor`, `borderColor`, …) take literal
 * color strings, not CSS `var(--…)` references. Same for `ImageData` /
 * `ctx.fillStyle` paths in our overlay panes. Each caller had a near-
 * identical resolver inline (`getComputedStyle` + trim + hex fallback);
 * this helper is the one definition.
 *
 * Each entry is a `[cssVar, fallback]` tuple — the tuple lets the JS key
 * differ from the CSS variable name (which contains dashes), so callers
 * can write `const { bgCard } = resolveTokens({ bgCard: ['--bg-card', '#13131C'] })`.
 *
 * Resolution rules:
 *   - No `document` (SSR / non-DOM test runner): return fallbacks verbatim.
 *   - `getPropertyValue` empty after trim: use the fallback.
 *   - Otherwise: trimmed CSS value.
 */
export type TokenSpec = readonly [cssVar: string, fallback: string];

export function resolveTokens<K extends string>(
  spec: Record<K, TokenSpec>,
): Record<K, string> {
  const out = {} as Record<K, string>;
  if (typeof document === 'undefined') {
    for (const key in spec) out[key] = spec[key][1];
    return out;
  }
  const cs = getComputedStyle(document.documentElement);
  for (const key in spec) {
    const [cssVar, fallback] = spec[key];
    const raw = cs.getPropertyValue(cssVar).trim();
    out[key] = raw.length > 0 ? raw : fallback;
  }
  return out;
}
