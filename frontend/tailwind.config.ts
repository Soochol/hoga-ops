import type { Config } from 'tailwindcss';
import { TAILWIND_THEME } from './src/styles/tokens.generated';

/*
 * borderRadius 만 `extend` 밖으로 뺀다 — `theme.borderRadius` 는 Tailwind 기본
 * 스케일을 **교체**하고, `theme.extend.borderRadius` 는 **병합**한다.
 *
 * 병합이면 우리가 안 정의한 `xl`(0.75rem)·`2xl`·`3xl` 이 해석 가능한 채로 남고,
 * 그 값들은 rem 기반이라 누가 한 번 쓰는 순간 밀도 다이얼 이탈이 재발한다
 * (ADR-0011 이 금지하는 것). 실제로 그 구멍으로 `rounded-xl` 이 종목 검색
 * 팔레트에 들어와 앱에서 유일한 13.5px 다이얼로그가 돼 있었다.
 *
 * 교체의 대가: 스케일에 없는 키는 **에러가 아니라 CSS 미생성**이다. 그래서
 * `radius-none` 이 토큰 표에 있어야 하고(위 주석), 새 단이 필요하면 임의값을
 * 쓰지 말고 design-tokens.ts 에 추가해야 한다 — 그게 이 교체의 요점이다.
 *
 * fontSize·spacing 등 나머지는 계속 `extend` 다. Tailwind 의 숫자 스페이싱
 * 스케일(p-1·px-2.5…)을 코드 전체가 쓰고 있어 교체하면 다 죽는다.
 */
const { borderRadius, ...EXTEND_THEME } = TAILWIND_THEME;

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
    // 교체(extend 아님) — 위 주석 참조.
    borderRadius,
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
        warn:    'var(--warn)',
        'price-up':   'var(--price-up)',
        'price-down': 'var(--price-down)',
        'qty-ask': 'var(--qty-ask)',
        'qty-bid': 'var(--qty-bid)',
        grid: 'var(--grid)',
        'heat-lo': 'var(--heat-lo)',
        'heat-hi': 'var(--heat-hi)',
        'ma-1': 'var(--ma-1)',
        'ma-2': 'var(--ma-2)',
        'ma-3': 'var(--ma-3)',
        'ma-4': 'var(--ma-4)',
        'ma-5': 'var(--ma-5)',
        'tint-selection':  'var(--tint-selection)',
        'tint-success':    'var(--tint-success)',
        'tint-error':      'var(--tint-error)',
        // `--tint-warn` 은 네 테마에 진작 있었는데 매핑만 없어 쓸 수가 없었다.
        'tint-warn':       'var(--tint-warn)',
        'tint-neutral':    'var(--tint-neutral)',
        'tint-success-border': 'var(--tint-success-border)',
        'tint-error-border':   'var(--tint-error-border)',
        'tint-price-up':   'var(--tint-price-up)',
        'tint-price-down': 'var(--tint-price-down)',
      },
      fontFamily: {
        ui: 'var(--font-ui)',
        sans: 'var(--font-ui)',
        // Data/number surfaces. The tuple's second slot makes Tailwind emit
        // font-feature-settings alongside font-family, so `font-data` carries
        // tabular figures *by construction* — a call site can't opt into the
        // data face and forget the alignment half. This is what replaced the
        // monospace face on 2026-07-21 (DESIGN.md decision log).
        data: ['var(--font-data)', { fontFeatureSettings: '"tnum"' }],
        // DEPRECATED alias — do not use in new code; use `font-data`.
        // Kept mapped (rather than deleted) on purpose: deleting the key would
        // let Tailwind's *default* mono stack take over any stray `font-mono`
        // left in an unmerged branch, silently rendering system monospace with
        // proportional-width digits. Aliasing fails safe instead.
        mono: ['var(--font-data)', { fontFeatureSettings: '"tnum"' }],
      },
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      // Theme-aware elevation tiers (see tokens.css Elevation). Components use
      // these instead of hardcoded rgba(0,0,0,…) arbitrary values so Ledger
      // gets paper shadows while Obsidian keeps deep terminal shadows.
      boxShadow: {
        overlay: 'var(--shadow-overlay)',
        panel: 'var(--shadow-panel)',
        modal: 'var(--shadow-modal)',
      },
      // Generated tokens (size, spacing, layout) — radius is on theme root above.
      ...EXTEND_THEME,
    },
  },
  plugins: [],
} satisfies Config;
