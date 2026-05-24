import { useEffect, useState } from 'react';
import { useTabsStore, type MAConfig, type MAIndex, CHART_TOGGLES, categoryOf } from '../../state/tabs';
import ToggleRow from './ToggleRow';

/** One row in the Moving Average list: checkbox + label + period input +
 *  color dot. The period input keeps its own draft string so partial edits
 *  ("3", "") don't fire a store write — commits happen on blur or Enter,
 *  and invalid values revert to the last accepted period. */
function MovingAverageRow({
  index,
  config,
  onChange,
}: {
  index: MAIndex;
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
    <div className="grid grid-cols-[36px_1fr_72px_16px] items-center gap-3 py-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={config.enabled}
        aria-label={label}
        onClick={() => onChange({ enabled: !config.enabled })}
        className={
          config.enabled
            ? 'relative inline-flex h-5 w-9 items-center rounded-full bg-accent transition-colors'
            : 'relative inline-flex h-5 w-9 items-center rounded-full bg-bg-input-hover transition-colors'
        }
      >
        <span
          className={
            config.enabled
              ? 'inline-block h-4 w-4 transform rounded-full bg-accent-fg translate-x-[18px] transition-transform'
              : 'inline-block h-4 w-4 transform rounded-full bg-fg-dim translate-x-[2px] transition-transform'
          }
        />
      </button>
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
      {/*
        Slot indices are 0-based in code (prefs.movingAverages[0..4]) but the
        CSS tokens are 1-based (--ma-1..--ma-5) for human readability per
        tokens.css convention. The +1 offset bridges the two.
      */}
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
 * "보조지표" category content for the Settings modal. Hosts the 5 Moving
 * Average slots and any toggles whose CHART_TOGGLES entry sets
 * `category: 'indicators'`. New indicator-scoped toggles appear here
 * automatically when added to the registry — no edits below required.
 */
export default function IndicatorsSection() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const prefs = useTabsStore((s) => s.getPrefs(activeTabId));
  const setMovingAverage = useTabsStore((s) => s.setMovingAverage);
  const setToggle = useTabsStore((s) => s.setToggle);

  const indicatorToggles = CHART_TOGGLES.filter((t) => categoryOf(t) === 'indicators');

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
          const index = i as MAIndex;
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
      {indicatorToggles.length > 0 && (
        <>
          <div className="text-fg-dim text-[11px] uppercase tracking-wider mb-2 mt-4">
            Fill Strength
          </div>
          {indicatorToggles.map((toggle) => {
            const key = toggle.key;
            return (
              <ToggleRow
                key={key}
                label={toggle.label}
                description={toggle.description}
                checked={prefs[key]}
                onToggle={() => setToggle(activeTabId, key, !prefs[key])}
                testId={`settings-toggle-${key}`}
              />
            );
          })}
        </>
      )}
    </>
  );
}
