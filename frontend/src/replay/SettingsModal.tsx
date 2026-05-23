import { useEffect, useState } from 'react';
import { CHART_TOGGLES, useTabsStore, type ChartToggleKey } from '../state/tabs';
import IndicatorsSection from './settings/IndicatorsSection';

type Props = {
  onClose: () => void;
};

type Category = 'chart' | 'indicators';

/** Single binary toggle row inside the Settings modal. Stateless — owner
 *  passes the current checked value and a click handler. */
function ToggleRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">{label}</div>
        <div className="text-fg-dim text-xs mt-0.5">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        className={
          checked
            ? 'relative inline-flex h-5 w-9 items-center rounded-full bg-accent transition-colors'
            : 'relative inline-flex h-5 w-9 items-center rounded-full bg-bg-input-hover transition-colors'
        }
      >
        <span
          className={
            checked
              ? 'inline-block h-4 w-4 transform rounded-full bg-accent-fg translate-x-[18px] transition-transform'
              : 'inline-block h-4 w-4 transform rounded-full bg-fg-dim translate-x-[2px] transition-transform'
          }
        />
      </button>
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
                {CHART_TOGGLES.map((toggle) => {
                  const key: ChartToggleKey = toggle.key;
                  return (
                    <ToggleRow
                      key={key}
                      label={toggle.label}
                      description={toggle.description}
                      checked={prefs[key]}
                      onToggle={() => setToggle(activeTabId, key, !prefs[key])}
                    />
                  );
                })}
                <VolumeProfileModeRow />
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
