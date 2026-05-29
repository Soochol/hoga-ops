import { Fragment, useEffect } from 'react';
import {
  useChartPrefsStore,
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  categoryOf,
} from '../state/chartPrefs';
import { SOURCE_OPTIONS } from '../state/sourcePreference';
import ToggleRow from './settings/ToggleRow';
import NumericPrefRow from './settings/NumericPrefRow';
import SourcePreferenceRadio from './settings/SourcePreferenceRadio';

type Props = {
  onClose: () => void;
};

export default function LiveSettingsModal({ onClose }: Props) {
  const prefs = useChartPrefsStore();
  const setToggle = useChartPrefsStore((s) => s.setToggle);

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
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">차트 설정</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4">
          {/* Each chart-category toggle is its own group; numeric prefs gated by
              `enabledBy` render indented under their parent toggle (registry-driven —
              adding a new toggle is one entry in CHART_TOGGLES). */}
          {CHART_TOGGLES.filter((t) => categoryOf(t) === 'chart').map((toggle, idx) => {
            const gatedNumerics = CHART_NUMERIC_PREFS.filter((p) => p.enabledBy === toggle.key);
            return (
              <Fragment key={toggle.key}>
                {idx > 0 && <div className="border-b border-border my-2" />}
                <ToggleRow
                  label={toggle.label}
                  description={toggle.description}
                  checked={prefs[toggle.key]}
                  onToggle={() => setToggle(toggle.key, !prefs[toggle.key])}
                  testId={`settings-toggle-${toggle.key}`}
                />
                {gatedNumerics.length > 0 && (
                  <div className="ml-4">
                    {gatedNumerics.map((def) => (
                      <NumericPrefRow key={def.key} def={def} />
                    ))}
                  </div>
                )}
              </Fragment>
            );
          })}
          {/* Ungated numerics (none today) would render here without indentation */}
          {CHART_NUMERIC_PREFS.filter((p) => p.enabledBy === undefined).map((def) => (
            <NumericPrefRow key={def.key} def={def} />
          ))}
          <div className="border-b border-border my-2" />
          <div style={{ marginTop: 'var(--space-md)' }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
              기본 데이터 소스 <span style={{ color: 'var(--fg-dimmer)' }}>(모든 차트 공통)</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
              {SOURCE_OPTIONS.map((opt) => (
                <SourcePreferenceRadio key={opt} value={opt} />
              ))}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-dimmer)', marginTop: 'var(--space-xs)' }}>
              현재 source는 차트 상단 칩에 표시됩니다.
            </div>
          </div>
        </div>
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
