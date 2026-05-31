import type { ScreenerFilters } from '../api/screener';

interface Props {
  value: ScreenerFilters;
  onChange: (next: ScreenerFilters) => void;
}

/** Lookback/period presets — headline 200·500 included per DESIGN DECISION. */
const PERIOD_PRESETS = [20, 60, 120, 200, 250, 500] as const;
const MARKETS = ['KOSPI', 'KOSDAQ'] as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-dimmer">
      {children}
    </div>
  );
}

/** A range-pill group (DESIGN.md Presets): --bg-input container, mono small-caps
 *  pills; active pill = teal bg + dark text. */
function PresetGroup({
  options, selected, onSelect, ariaLabel,
}: {
  options: readonly number[];
  selected: number | undefined;
  onSelect: (n: number) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap gap-px p-[2px] bg-bg-input rounded-md"
    >
      {options.map((n) => {
        const active = selected === n;
        return (
          <button
            key={n}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(n)}
            className={`px-2 py-[0.15rem] rounded-sm font-mono text-xs tabular-nums transition-colors ${
              active ? 'bg-accent text-accent-fg' : 'text-fg-dim hover:bg-bg-input-hover'
            }`}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

/** Left-pane condition panel for the screener. Controlled — owns no state; the
 *  page holds `ScreenerFilters` and drives 조회. */
export function ConditionPanel({ value, onChange }: Props) {
  const markets = value.markets ?? [];

  const toggleMarket = (m: (typeof MARKETS)[number]) => {
    const next = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    onChange({ ...value, markets: next.length ? next : undefined });
  };

  const setBreakout = (
    key: 'newHigh' | 'newHighVol',
    patch: { lookback?: number; period?: number },
  ) => {
    const cur = value[key] ?? { lookback: 200, period: 500 };
    onChange({ ...value, [key]: { ...cur, ...patch } });
  };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-lg min-h-0 overflow-auto">
      {/* 거래대금 하한 */}
      <div className="flex flex-col gap-sm">
        <SectionLabel>거래대금 하한 (억)</SectionLabel>
        <input
          type="number"
          inputMode="numeric"
          aria-label="거래대금 하한 (억)"
          value={value.minTradeValueEok ?? ''}
          onChange={(e) =>
            onChange({
              ...value,
              minTradeValueEok: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
          className="w-full bg-bg-input border border-border rounded-md px-2 py-1 font-mono text-sm tabular-nums text-fg"
        />
      </div>

      {/* 신고가 */}
      <div className="flex flex-col gap-sm">
        <SectionLabel>신고가 — lookback</SectionLabel>
        <PresetGroup
          ariaLabel="신고가 lookback"
          options={PERIOD_PRESETS}
          selected={value.newHigh?.lookback}
          onSelect={(n) => setBreakout('newHigh', { lookback: n })}
        />
        <SectionLabel>신고가 — period</SectionLabel>
        <PresetGroup
          ariaLabel="신고가 period"
          options={PERIOD_PRESETS}
          selected={value.newHigh?.period}
          onSelect={(n) => setBreakout('newHigh', { period: n })}
        />
      </div>

      {/* 신고거래량 */}
      <div className="flex flex-col gap-sm">
        <SectionLabel>신고거래량 — lookback</SectionLabel>
        <PresetGroup
          ariaLabel="신고거래량 lookback"
          options={PERIOD_PRESETS}
          selected={value.newHighVol?.lookback}
          onSelect={(n) => setBreakout('newHighVol', { lookback: n })}
        />
        <SectionLabel>신고거래량 — period</SectionLabel>
        <PresetGroup
          ariaLabel="신고거래량 period"
          options={PERIOD_PRESETS}
          selected={value.newHighVol?.period}
          onSelect={(n) => setBreakout('newHighVol', { period: n })}
        />
      </div>

      {/* 시장 */}
      <div className="flex flex-col gap-sm">
        <SectionLabel>시장</SectionLabel>
        <div className="flex gap-px p-[2px] bg-bg-input rounded-md w-fit">
          {MARKETS.map((m) => {
            const active = markets.includes(m);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={active}
                onClick={() => toggleMarket(m)}
                className={`px-2.5 py-[0.15rem] rounded-sm font-mono text-xs transition-colors ${
                  active ? 'bg-accent text-accent-fg' : 'text-fg-dim hover:bg-bg-input-hover'
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>

      {/* ETF 제외 */}
      <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
        <input
          type="checkbox"
          checked={!!value.excludeEtf}
          onChange={(e) => onChange({ ...value, excludeEtf: e.target.checked || undefined })}
          className="accent-[var(--accent)]"
        />
        ETF 제외
      </label>
    </div>
  );
}
