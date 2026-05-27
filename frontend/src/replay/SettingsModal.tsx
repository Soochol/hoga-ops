import { useEffect, useState } from 'react';
import {
  categoryOf,
  CHART_NUMERIC_PREFS,
  CHART_TOGGLES,
  useTabsStore,
  type ChartToggleKey,
  type NumericPrefDef,
  type NumericPrefKey,
} from '../state/tabs';
import { useSourcePreferenceStore, SOURCE_OPTIONS, type SourcePreference } from '../state/sourcePreference';
import IndicatorsSection from './settings/IndicatorsSection';
import ToggleRow from './settings/ToggleRow';

type Props = {
  onClose: () => void;
};

type Category = 'chart' | 'indicators';

/** Generic integer-input row driven by one `NumericPrefDef` entry. Mirrors
 *  the toggle-row auto-rendering pattern: SettingsModal iterates
 *  `CHART_NUMERIC_PREFS` and renders one of these per entry — no per-pref
 *  JSX. Draft-string editing follows `MovingAverageRow` (commit on blur or
 *  Enter, revert invalid input). When `def.enabledBy` is set, the row is
 *  dimmed and disabled while that toggle is off, but the value is preserved
 *  so re-enabling restores it without re-entry. */
function NumericPrefRow({ def }: { def: NumericPrefDef }) {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // NumericPrefDef.key is structurally `string` but originates from
  // CHART_NUMERIC_PREFS — the cast narrows it to NumericPrefKey so the index
  // lookup hits the mapped-type branch of ChartViewPrefs.
  const value = useTabsStore((s) => s.getPrefs(activeTabId)[def.key as NumericPrefKey]);
  const gateEnabled = useTabsStore((s) =>
    def.enabledBy === undefined ? true : s.getPrefs(activeTabId)[def.enabledBy],
  );
  const setNumericPref = useTabsStore((s) => s.setNumericPref);
  const [inputValue, setInputValue] = useState<string>(String(value));

  useEffect(() => {
    setInputValue(String(value));
  }, [value]);

  const commit = () => {
    const trimmed = inputValue.trim();
    const n = Number(trimmed);
    if (
      trimmed !== ''
      && Number.isFinite(n)
      && Number.isInteger(n)
      && n >= def.min
      && n <= def.max
      && n !== value
    ) {
      // Cast is safe: NumericPrefDef.key originates from CHART_NUMERIC_PREFS,
      // whose union narrows to NumericPrefKey at the registry seam. The
      // structural typedef can't carry the literal union forward.
      setNumericPref(activeTabId, def.key as NumericPrefKey, n);
    } else {
      setInputValue(String(value));
    }
  };

  return (
    <div
      className={
        gateEnabled
          ? 'flex items-center justify-between py-2'
          : 'flex items-center justify-between py-2 opacity-50'
      }
    >
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">{def.label}</div>
        <div className="text-fg-dim text-xs mt-0.5">
          {def.description} ({def.min.toLocaleString()}–{def.max.toLocaleString()})
        </div>
      </div>
      <input
        type="number"
        min={def.min}
        max={def.max}
        step={1}
        disabled={!gateEnabled}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        aria-label={def.label}
        data-testid={`settings-numeric-${def.key}`}
        className="w-[72px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums disabled:cursor-not-allowed"
      />
    </div>
  );
}

/** Segmented control row for the per-tab `volumeProfileMode` preference.
 *  Visually parallels `ToggleRow` (left label + right control). The two
 *  buttons render as a small inline segment — same active/inactive token
 *  pair previously used by the sidebar VolumeProfileModeToggle. */
function VolumeProfileModeRow() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const mode = useTabsStore((s) => s.getPrefs(activeTabId).volumeProfileMode);
  const setMode = useTabsStore((s) => s.setVolumeProfileMode);
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">Volume Profile</div>
        <div className="text-fg-dim text-xs mt-0.5">전체 기간 합산 / 날짜별 분리</div>
      </div>
      <div
        role="group"
        aria-label="Volume Profile"
        data-testid="settings-volume-profile-mode"
        className="flex items-center gap-1 text-xs"
      >
        {(['range', 'per-day'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-label={m === 'range' ? '전체' : '일별'}
            aria-pressed={mode === m}
            onClick={() => {
              if (mode !== m) setMode(activeTabId, m);
            }}
            className={
              mode === m
                ? 'px-2 py-0.5 bg-accent text-accent-fg rounded'
                : 'px-2 py-0.5 text-fg-dim hover:text-fg'
            }
          >
            {m === 'range' ? '전체' : '일별'}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Radio button row for the global Source Preference setting (ADR-0039).
 * Exported for isolated unit testing.
 */
export function SourcePreferenceRadio({ value }: { value: SourcePreference }) {
  const current = useSourcePreferenceStore((s) => s.sourcePreference);
  const setPref = useSourcePreferenceStore((s) => s.setSourcePreference);
  const labelMap: Record<SourcePreference, string> = {
    hogaplay: 'hogaplay 우선',
    kis_live: 'kis_live 우선',
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', cursor: 'pointer' }}>
      <input
        type="radio"
        name="source-preference"
        value={value}
        checked={current === value}
        onChange={() => setPref(value)}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>
        {labelMap[value]}
      </span>
    </label>
  );
}

/**
 * Centered modal overlay for chart settings. The "차트" category iterates
 * `CHART_TOGGLES` (the declarative registry on the tabs store) so adding a
 * new toggle is one entry in that array — no JSX edits here.
 *
 * Close paths: Escape key, backdrop click, header ✕, footer 닫기.
 * Toggle changes persist immediately to the per-tab prefs (no save button).
 */
export default function SettingsModal({ onClose }: Props) {
  const [category, setCategory] = useState<Category>('chart');
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const prefs = useTabsStore((s) => s.getPrefs(activeTabId));
  const setToggle = useTabsStore((s) => s.setToggle);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="설정"
      onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[640px] max-w-[90vw] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">설정</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex">
          <nav className="w-[180px] py-2 border-r border-border" aria-label="설정 카테고리">
            <button
              type="button"
              onClick={() => setCategory('chart')}
              aria-pressed={category === 'chart'}
              className={
                category === 'chart'
                  ? 'block w-full text-left px-4 py-2 text-sm bg-bg-input text-fg font-medium border-l-2 border-accent'
                  : 'block w-full text-left px-4 py-2 text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg'
              }
            >
              차트
            </button>
            <button
              type="button"
              onClick={() => setCategory('indicators')}
              aria-pressed={category === 'indicators'}
              className={
                category === 'indicators'
                  ? 'block w-full text-left px-4 py-2 text-sm bg-bg-input text-fg font-medium border-l-2 border-accent'
                  : 'block w-full text-left px-4 py-2 text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg'
              }
            >
              보조지표
            </button>
          </nav>

          <div className="flex-1 px-5 py-4">
            {category === 'chart' && (
              <>
                <h3 className="text-fg text-base font-medium pb-2 mb-2 border-b border-border">
                  차트
                </h3>
                {CHART_TOGGLES.filter((t) => categoryOf(t) === 'chart').map((toggle) => {
                  const key: ChartToggleKey = toggle.key;
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
                {CHART_NUMERIC_PREFS.map((def) => (
                  <NumericPrefRow key={def.key} def={def} />
                ))}
                <VolumeProfileModeRow />
                <div style={{ marginTop: 'var(--space-md)' }}>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
                    기본 데이터 소스 <span style={{ color: 'var(--fg-dimmer)' }}>(모든 차트 공통)</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
                    {SOURCE_OPTIONS.map((opt) => (
                      <SourcePreferenceRadio key={opt} value={opt} />
                    ))}
                  </div>
                  <div style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--fg-dimmer)',
                    marginTop: 'var(--space-xs)',
                  }}>
                    현재 source는 차트 상단 칩에 표시됩니다.
                  </div>
                </div>
              </>
            )}
            {category === 'indicators' && <IndicatorsSection />}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
