import { type CSSProperties } from 'react';
import { TABS_SOFT_CAP, type LiveTab } from '../state/liveTabs';

interface Props {
  tabs: LiveTab[];
  activeTabId: string | null;
  /** 활성 탭의 차트 데이터 로딩 중 여부 (상태점). */
  activeLoading: boolean;
  atCap: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void; // Task 8 드래그 핸들러가 사용
  onNewTab: () => void;
}

/** 상태점: 활성+로딩=accent pulse(◌), 활성+로드=success(●), 비활성=dimmer outline(○). */
function statusDotStyle(active: boolean, loading: boolean): CSSProperties {
  if (active && loading) return { background: 'var(--accent)', animation: 'tab-pulse 1.5s ease-in-out infinite' };
  if (active) return { background: 'var(--success)', boxShadow: '0 0 4px color-mix(in srgb, var(--success) 50%, transparent)' };
  return { background: 'transparent', border: '1px solid var(--fg-dimmer)' };
}

export function LiveTabBar({ tabs, activeTabId, activeLoading, atCap, onFocus, onClose, onReorder, onNewTab }: Props) {
  return (
    <div role="tablist" className="flex items-end gap-0.5 h-full px-2 font-ui" style={{ background: 'var(--bg-subtle)' }}>
      {tabs.map((t, idx) => {
        const active = t.id === activeTabId;
        return (
          <div
            key={t.id}
            data-tab-id={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onFocus(t.id)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.id); } }}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/tab-index', String(idx)); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('text/tab-index')) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              const raw = e.dataTransfer.getData('text/tab-index');
              if (raw === '') return; // 외부 드래그(텍스트/링크/파일) — 우리 탭 아님
              const from = Number(raw);
              if (Number.isInteger(from) && from !== idx) onReorder(from, idx);
            }}
            // 비활성 배경은 inline이 아닌 className으로 둔다: inline style은 specificity로
            // hover: 클래스를 이겨 hover 배경이 silent no-op이 되기 때문(DESIGN.md §Tabs Hover).
            className={`relative flex items-center gap-1.5 h-8 px-2.5 rounded-t-md cursor-pointer select-none group ${
              active ? 'bg-bg-card' : 'bg-bg-input hover:bg-bg-input-hover'
            }`}
            style={{
              border: active ? 'none' : '1px solid var(--border)',
              borderBottom: 'none',
            }}
          >
            {active && (
              <span className="absolute left-0 right-0 top-0 h-[2px]" style={{ background: 'var(--accent)' }} />
            )}
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={statusDotStyle(active, activeLoading)} />
            {/* 종목명만 표시 (확정 2026-06-11). label은 종목명이며, 이름을 모르는 탭(마이그레이션 등)만
                label===code 폴백으로 코드가 보인다. 긴 이름은 말줄임. */}
            <span className="text-sm shrink-0 max-w-40 truncate" title={t.label} style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)' }}>{t.label}</span>
            <button
              type="button"
              draggable={false}
              aria-label={`${t.code} 닫기`}
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              className="ml-1 w-[18px] h-[18px] flex items-center justify-center rounded opacity-0 group-hover:opacity-100"
              style={{ color: 'var(--fg-dimmer)' }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-[11px] h-[11px]">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="새 탭"
        onClick={onNewTab}
        disabled={atCap}
        className="ml-1 w-7 h-7 flex items-center justify-center rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ color: 'var(--fg-dim)', border: '1px solid var(--border)' }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="w-[13px] h-[13px]">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <span className="ml-auto self-center text-xs font-mono" style={{ color: atCap ? 'var(--error)' : 'var(--fg-dimmer)' }}>
        {tabs.length}/{TABS_SOFT_CAP} open
      </span>
    </div>
  );
}
