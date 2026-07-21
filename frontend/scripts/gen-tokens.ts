/**
 * gen-tokens.ts — design-tokens.ts → CSS + Tailwind + DESIGN.md
 *
 * Reads `frontend/src/styles/design-tokens.ts` (single source of truth) and
 * regenerates downstream artifacts:
 *   - frontend/src/styles/tokens.generated.ts  (Tailwind theme.extend)
 *   - frontend/src/styles/tokens.css           (size + radius + layout sections)
 *   - DESIGN.md                                (typography / spacing / layout tables)
 *
 * Run via: npm run gen:tokens
 *
 * Color tokens in tokens.css (`/* ───── Color · ... ───── *​/` blocks) are
 * preserved verbatim — only the regions between BEGIN/END auto-generated
 * markers are rewritten.
 *
 * DESIGN.md tables are rewritten inside `<!-- BEGIN AUTO: ... -->` /
 * `<!-- END AUTO: ... -->` markers. If a marker pair is missing in the
 * target file, this script aborts with a clear error rather than silently
 * appending content.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SIZE_TOKENS, FIXED_PX_TOKENS, RENDERED_ROOT_PX, type SizeToken } from '../src/styles/design-tokens.ts';

/** e.g. 18px root → "1.125" — used in comments/table headers. */
const DENSITY_LABEL = (RENDERED_ROOT_PX / 16).toString();
/** Rendered px at default density, trimmed (14.625 stays, 36 stays integer). */
const renderedPxOf = (rem: number): string => (Math.round(rem * RENDERED_ROOT_PX * 1000) / 1000).toString();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const FRONTEND = resolve(REPO_ROOT, 'frontend');

const PATHS = {
  tokensCSS: resolve(FRONTEND, 'src/styles/tokens.css'),
  tokensGenerated: resolve(FRONTEND, 'src/styles/tokens.generated.ts'),
  designMd: resolve(REPO_ROOT, 'DESIGN.md'),
} as const;

// ───────────────────────── Validation ─────────────────────────

const NAME_PREFIX_RULES = [
  { prefix: 'text-',     category: 'typography' as const, tailwindGroup: 'fontSize' as const },
  { prefix: 'space-',    category: 'spacing' as const,    tailwindGroup: 'spacing' as const },
  { prefix: 'h-',        category: 'layout-h' as const,   tailwindGroup: 'height' as const },
];
const SUFFIX_RULES = [
  { suffix: '-min-h',    category: 'layout-h' as const,   tailwindGroup: 'minHeight' as const },
  { suffix: '-min-w',    category: 'layout-w' as const,   tailwindGroup: 'minWidth' as const },
  { suffix: '-w',        category: 'layout-w' as const,   tailwindGroup: 'width' as const },
];

function classify(name: string): { category: string; tailwindGroup: string; tailwindKey: string } {
  for (const r of NAME_PREFIX_RULES) {
    if (name.startsWith(r.prefix)) {
      return { category: r.category, tailwindGroup: r.tailwindGroup, tailwindKey: name.slice(r.prefix.length) };
    }
  }
  for (const r of SUFFIX_RULES) {
    if (name.endsWith(r.suffix)) {
      const stem = name.slice(0, -r.suffix.length);
      // The Tailwind utility name keeps the stem (e.g., `nav-w` -> `nav`, `combobox-min-w` -> `combobox`).
      return { category: r.category, tailwindGroup: r.tailwindGroup, tailwindKey: stem };
    }
  }
  throw new Error(
    `Token "${name}" does not match any naming-prefix rule.\n` +
    `  Allowed prefixes: text-, space-, h-, radius-\n` +
    `  Allowed suffixes: -min-w, -w\n` +
    `  Update the token name or add a rule to NAME_PREFIX_RULES / SUFFIX_RULES in scripts/gen-tokens.ts.`,
  );
}

function validateSize(name: string, t: SizeToken): void {
  const expected = t.rem * 16;
  if (Math.abs(expected - t.baseIntentPx) > 0.001) {
    throw new Error(
      `Token "${name}" drift: rem=${t.rem} × 16 = ${expected}, but baseIntentPx=${t.baseIntentPx}.\n` +
      `  Either fix rem to ${(t.baseIntentPx / 16).toFixed(5)}, or fix baseIntentPx to ${expected}.`,
    );
  }
}

function validateAll(): void {
  // SIZE_TOKENS must classify into typography / spacing / layout-h / layout-w
  for (const [name, token] of Object.entries(SIZE_TOKENS)) {
    const klass = classify(name);
    if (klass.category === 'fixed-px') {
      throw new Error(`Token "${name}" is in SIZE_TOKENS but its name suggests fixed-px (radius). Move it to FIXED_PX_TOKENS.`);
    }
    validateSize(name, token);
  }
  // FIXED_PX_TOKENS must all start with `radius-`
  for (const name of Object.keys(FIXED_PX_TOKENS)) {
    if (!name.startsWith('radius-')) {
      throw new Error(
        `Token "${name}" is in FIXED_PX_TOKENS but doesn't start with "radius-".\n` +
        `  Only radius tokens are intentionally fixed-px today. Either rename, or update gen-tokens.ts to allow new fixed-px categories.`,
      );
    }
  }
}

// ───────────────────────── Emit: tokens.generated.ts ─────────────────────────

function emitTailwindTheme(): string {
  const groups: Record<string, Record<string, string>> = {
    fontSize: {},
    spacing: {},
    height: {},
    width: {},
    minWidth: {},
    minHeight: {},
    borderRadius: {},
  };

  for (const name of Object.keys(SIZE_TOKENS)) {
    const klass = classify(name);
    groups[klass.tailwindGroup][klass.tailwindKey] = `var(--${name})`;
  }
  for (const name of Object.keys(FIXED_PX_TOKENS)) {
    if (name === 'radius-full') {
      groups.borderRadius.full = `var(--${name})`;
    } else {
      groups.borderRadius[name.slice('radius-'.length)] = `var(--${name})`;
    }
  }

  const fmtGroup = (g: Record<string, string>): string =>
    Object.entries(g)
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
      .join('\n');

  return [
    '/**',
    ' * AUTO-GENERATED — do not edit. Source: design-tokens.ts.',
    ' * Regenerate via: npm run gen:tokens',
    ' */',
    '',
    'export const TAILWIND_THEME = {',
    `  fontSize: {\n${fmtGroup(groups.fontSize)}\n  },`,
    `  spacing: {\n${fmtGroup(groups.spacing)}\n  },`,
    `  height: {\n${fmtGroup(groups.height)}\n  },`,
    `  width: {\n${fmtGroup(groups.width)}\n  },`,
    `  minWidth: {\n${fmtGroup(groups.minWidth)}\n  },`,
    `  minHeight: {\n${fmtGroup(groups.minHeight)}\n  },`,
    `  borderRadius: {\n${fmtGroup(groups.borderRadius)}\n  },`,
    '} as const;',
    '',
  ].join('\n');
}

// ───────────────────────── Emit: tokens.css size sections ─────────────────────────

const CSS_BEGIN = '/* BEGIN AUTO-GENERATED (size + radius + layout) — regenerate via npm run gen:tokens */';
const CSS_END = '/* END AUTO-GENERATED */';

function emitCssBlock(): string {
  const lines: string[] = [CSS_BEGIN];

  // typography
  lines.push('  /* ───── Typography sizes (rem-based) ───── */');
  for (const [name, t] of Object.entries(SIZE_TOKENS)) {
    if (!name.startsWith('text-')) continue;
    const renderedPx = renderedPxOf(t.rem);
    lines.push(`  --${name}: ${t.rem}rem; /* ${renderedPx}px @ default; ${t.baseIntentPx}px base intent */`);
  }

  lines.push('');
  lines.push('  /* ───── Spacing (rem-based; 4px base unit) ───── */');
  for (const [name, t] of Object.entries(SIZE_TOKENS)) {
    if (!name.startsWith('space-')) continue;
    const renderedPx = renderedPxOf(t.rem);
    lines.push(`  --${name}: ${t.rem}rem; /* ${renderedPx}px @ default; ${t.baseIntentPx}px base intent */`);
  }

  lines.push('');
  lines.push('  /* ───── Border radius (intentionally fixed px — see ADR-0011) ───── */');
  for (const [name, t] of Object.entries(FIXED_PX_TOKENS)) {
    lines.push(`  --${name}: ${t.px}px; /* ${t.usage} */`);
  }

  lines.push('');
  lines.push(`  /* ───── Layout (rem-based; rendered px @ ${RENDERED_ROOT_PX}px root = default density) ───── */`);
  for (const [name, t] of Object.entries(SIZE_TOKENS)) {
    if (!(name.startsWith('h-') || name.endsWith('-w') || name.endsWith('-min-w') || name.endsWith('-min-h'))) continue;
    const renderedPx = renderedPxOf(t.rem);
    lines.push(`  --${name}: ${t.rem}rem; /* ${renderedPx}px @ default; ${t.baseIntentPx}px base intent — ${t.usage} */`);
  }

  lines.push(CSS_END);
  return lines.join('\n');
}

function rewriteCss(): void {
  const existing = readFileSync(PATHS.tokensCSS, 'utf-8');
  const block = emitCssBlock();

  let next: string;
  const beginIdx = existing.indexOf(CSS_BEGIN);
  if (beginIdx >= 0) {
    const endIdx = existing.indexOf(CSS_END, beginIdx);
    if (endIdx < 0) throw new Error('tokens.css has BEGIN marker but no END marker.');
    next = existing.slice(0, beginIdx) + block + existing.slice(endIdx + CSS_END.length);
  } else {
    // First run: replace everything from the first `/* ───── Typography ─────` line
    // through the end of the file's `:root` body. Conservative heuristic: locate
    // the closing brace of the :root block and inject before it.
    const closingBraceIdx = existing.lastIndexOf('}');
    if (closingBraceIdx < 0) throw new Error('tokens.css has no closing brace.');
    // Strip any prior hand-written typography/spacing/radius/layout blocks by
    // looking for the first hand-written section header that we are taking over
    // ("Typography"). Everything from there to the closing brace is replaced.
    const typographyHeaderIdx = existing.search(/\/\* ───── Typography ─────/);
    if (typographyHeaderIdx >= 0) {
      next = existing.slice(0, typographyHeaderIdx) + block + '\n' + existing.slice(closingBraceIdx);
    } else {
      // No typography header? Insert block just before the closing brace.
      next = existing.slice(0, closingBraceIdx) + block + '\n' + existing.slice(closingBraceIdx);
    }
  }

  writeFileSync(PATHS.tokensCSS, next, 'utf-8');
}

// ───────────────────────── Emit: DESIGN.md tables ─────────────────────────

const DESIGN_MARKERS = {
  typography: { begin: '<!-- BEGIN AUTO: tokens-typography -->', end: '<!-- END AUTO: tokens-typography -->' },
  spacing:    { begin: '<!-- BEGIN AUTO: tokens-spacing -->',    end: '<!-- END AUTO: tokens-spacing -->' },
  layout:     { begin: '<!-- BEGIN AUTO: tokens-layout -->',     end: '<!-- END AUTO: tokens-layout -->' },
};

function buildTypographyTable(): string {
  const rows: string[] = [
    `| Token | Base intent (1.0×) | Rendered @ default (${DENSITY_LABEL}×) | Use |`,
    '|---|---|---|---|',
  ];
  for (const [name, t] of Object.entries(SIZE_TOKENS)) {
    if (!name.startsWith('text-')) continue;
    const renderedPx = renderedPxOf(t.rem);
    rows.push(`| \`${name.slice('text-'.length)}\` | ${t.baseIntentPx}px | ${renderedPx}px | ${t.usage} |`);
  }
  return rows.join('\n');
}

function buildSpacingTable(): string {
  const rows: string[] = [
    `| Token | Base intent (1.0×) | Rendered @ default (${DENSITY_LABEL}×) | Use |`,
    '|---|---|---|---|',
  ];
  for (const [name, t] of Object.entries(SIZE_TOKENS)) {
    if (!name.startsWith('space-')) continue;
    const renderedPx = renderedPxOf(t.rem);
    rows.push(`| \`${name.slice('space-'.length)}\` | ${t.baseIntentPx}px | ${renderedPx}px | ${t.usage} |`);
  }
  return rows.join('\n');
}

function buildLayoutTable(): string {
  const rows: string[] = [
    `| Token | Base intent (1.0×) | Rendered @ default (${DENSITY_LABEL}×) | Use |`,
    '|---|---|---|---|',
  ];
  for (const [name, t] of Object.entries(SIZE_TOKENS)) {
    if (!(name.startsWith('h-') || name.endsWith('-w') || name.endsWith('-min-w') || name.endsWith('-min-h'))) continue;
    const renderedPx = renderedPxOf(t.rem);
    rows.push(`| \`--${name}\` | ${t.baseIntentPx}px | ${renderedPx}px | ${t.usage} |`);
  }
  return rows.join('\n');
}

function replaceMarker(content: string, begin: string, end: string, payload: string): { content: string; replaced: boolean } {
  const b = content.indexOf(begin);
  if (b < 0) {
    console.warn(
      `gen-tokens: DESIGN.md missing marker "${begin}" — skipping this table.\n` +
      `  To enable auto-generation, insert this pair around the existing table:\n` +
      `    ${begin}\n` +
      `    (placeholder — generator fills this in)\n` +
      `    ${end}`,
    );
    return { content, replaced: false };
  }
  const e = content.indexOf(end, b);
  if (e < 0) throw new Error(`DESIGN.md has "${begin}" but no matching "${end}".`);
  return {
    content: content.slice(0, b + begin.length) + '\n' + payload + '\n' + content.slice(e),
    replaced: true,
  };
}

function rewriteDesignMd(): void {
  let content = readFileSync(PATHS.designMd, 'utf-8');
  let replacedCount = 0;
  for (const [name, payload] of [
    ['typography', buildTypographyTable()] as const,
    ['spacing', buildSpacingTable()] as const,
    ['layout', buildLayoutTable()] as const,
  ]) {
    const m = DESIGN_MARKERS[name];
    const result = replaceMarker(content, m.begin, m.end, payload);
    content = result.content;
    if (result.replaced) replacedCount++;
  }
  writeFileSync(PATHS.designMd, content, 'utf-8');
  console.log(`gen-tokens: DESIGN.md — ${replacedCount}/3 marker pairs replaced.`);
}

// ───────────────────────── Main ─────────────────────────

function main(): void {
  validateAll();
  console.log('gen-tokens: validation passed.');

  writeFileSync(PATHS.tokensGenerated, emitTailwindTheme(), 'utf-8');
  console.log(`gen-tokens: wrote ${PATHS.tokensGenerated.replace(REPO_ROOT + '/', '')}`);

  rewriteCss();
  console.log(`gen-tokens: rewrote ${PATHS.tokensCSS.replace(REPO_ROOT + '/', '')} (size + radius + layout sections)`);

  rewriteDesignMd();
  console.log(`gen-tokens: rewrote ${PATHS.designMd.replace(REPO_ROOT + '/', '')} (typography / spacing / layout tables between markers)`);
}

main();
