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

/**
 * The active theme name off `<html data-theme>`. `'obsidian'` when unset
 * (jsdom / first paint before the bootstrap script runs). This is the cache
 * key for `resolveTokensThemed` and the invalidation signal projectors store
 * on their axis-lifetime cache entries — a chart that outlives a theme swap
 * (module constants resolve ONCE at app boot; the axis-keyed WeakMap survives
 * a remount) must re-resolve when this changes.
 */
export function currentThemeKey(): string {
  if (typeof document === 'undefined') return 'obsidian';
  return document.documentElement.getAttribute('data-theme') ?? 'obsidian';
}

/**
 * Theme-aware `resolveTokens`. Resolves lazily (call it inside the projection
 * function, not at module load) so canvas color options track the live theme.
 * Results are cached per `(spec, theme)` — the tick path can call this every
 * frame without re-running `getComputedStyle`; a theme swap changes the key and
 * misses once. The WeakMap is keyed by the stable module-level spec object.
 */
const themedTokenCache = new WeakMap<object, Map<string, Record<string, string>>>();

export function resolveTokensThemed<K extends string>(
  spec: Record<K, TokenSpec>,
): Record<K, string> {
  const theme = currentThemeKey();
  let perTheme = themedTokenCache.get(spec);
  if (!perTheme) {
    perTheme = new Map();
    themedTokenCache.set(spec, perTheme);
  }
  let out = perTheme.get(theme) as Record<K, string> | undefined;
  if (!out) {
    out = resolveTokens(spec);
    perTheme.set(theme, out);
  }
  return out;
}
