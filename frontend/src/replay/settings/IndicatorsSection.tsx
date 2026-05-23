import { useEffect, useState } from 'react';
import { useTabsStore, type MAConfig } from '../../state/tabs';

type MARowIndex = 0 | 1 | 2 | 3 | 4;

/** One row in the Moving Average list: checkbox + label + period input +
 *  color dot. The period input keeps its own draft string so partial edits
 *  ("3", "") don't fire a store write — commits happen on blur or Enter,
 *  and invalid values revert to the last accepted period. */
function MovingAverageRow({
  index,
  config,
  onChange,
}: {
  index: MARowIndex;
  config: MAConfig;
  onChange: (patch: Partial<MAConfig>) => void;
}) {
  const [inputValue, setInputValue] = useState<string>(String(config.period));

  // Re-sync local draft when the upstream period changes (e.g. tab switch
  // or external setMovingAverage). Comparing against the current draft
  // string would be wrong here — we always want the canonical value.
  useEffect(() => {
    setInputValue(String(config.period));
  }, [config.period]);

  const commit = () => {
    const trimmed = inputValue.trim();
    const n = Number(trimmed);
    if (
      trimmed !== '' &&
      Number.isFinite(n) &&
      Number.isInteger(n) &&
      n >= 2 &&
      n <= 400 &&
      n !== config.period
    ) {
      onChange({ period: n });
    } else {
      // Invalid or unchanged — revert the draft.
      setInputValue(String(config.period));
    }
  };

  const label = `MA ${config.period}`;
  return (
    <div className="grid grid-cols-[24px_1fr_72px_16px] items-center gap-3 py-1.5">
      <input
        type="checkbox"
        className="h-[14px] w-[14px]"
        checked={config.enabled}
        onChange={() => onChange({ enabled: !config.enabled })}
        aria-label={label}
      />
      <div className="text-sm text-fg tabular-nums">{label}</div>
      <input
        type="number"
        min={2}
        max={400}
        step={1}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        aria-label={`${label} 기간`}
        className="w-[72px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums"
      />
      <span
        aria-hidden="true"
        data-testid={`ma-color-dot-${index}`}
        className="inline-block h-3 w-3 rounded-full"
        style={{ backgroundColor: `var(--ma-${index + 1})` }}
      />
    </div>
  );
}

/**
 * "보조지표" category content for the Settings modal. Currently surfaces
 * the 5 Moving Average slots; future indicator groups (RSI, MACD, …) will
 * sit underneath the same heading with their own small uppercase tag.
 */
export default function IndicatorsSection() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const prefs = useTabsStore((s) => s.getPrefs(activeTabId));
  const setMovingAverage = useTabsStore((s) => s.setMovingAverage);

  return (
    <>
      <h3 className="text-fg text-base font-medium pb-2 mb-2 border-b border-border">
        보조지표
      </h3>
      <div className="text-fg-dim text-[11px] uppercase tracking-wider mb-2">
        Moving Average
      </div>
      <div>
        {prefs.movingAverages.map((cfg, i) => {
          const index = i as MARowIndex;
          return (
            <MovingAverageRow
              key={index}
              index={index}
              config={cfg}
              onChange={(patch) => setMovingAverage(activeTabId, index, patch)}
            />
          );
        })}
      </div>
    </>
  );
}
