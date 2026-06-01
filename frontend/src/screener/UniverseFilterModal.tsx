import { useState } from 'react';
import type { ScreenerUniverse } from '../api/screener';
import { ModalShell } from '../ui/ModalShell';
import { SectionLabel } from './paramForms';

const MARKETS = ['KOSPI', 'KOSDAQ'] as const;
type Group = 'market' | 'exclude';

// 활성=accent 채운 원+체크, 비활성=hollow ring (IndicatorPanel CheckIcon 모양 복제).
function NavCheck({ active }: { active: boolean }) {
  return active ? (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="var(--accent)" />
      <path d="M7.5 12.5l3 3 6-6" stroke="var(--accent-fg)" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="var(--fg-dimmer)" strokeWidth="1.5" />
    </svg>
  );
}

// 전역 사전필터 편집 모달. 좌측 nav 2그룹(시장/제외) + 우측 pane 전환.
// 토글은 즉시 onChange 호출(초안 버퍼 없음); 닫기/Esc/배경은 순수 dismiss.
export function UniverseFilterModal({ universe, onChange, onClose }: {
  universe: ScreenerUniverse;
  onChange: (u: ScreenerUniverse) => void;
  onClose: () => void;
}) {
  const [group, setGroup] = useState<Group>('market');
  const markets = universe.markets ?? [];
  const toggleMarket = (m: (typeof MARKETS)[number]) => {
    const next = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    onChange({ ...universe, markets: next.length ? next : undefined });
  };
  const NAV: { id: Group; label: string; active: boolean }[] = [
    { id: 'market', label: '시장', active: !!universe.markets?.length },
    { id: 'exclude', label: '제외', active: !!(universe.exclude_etf || universe.exclude_halted) },
  ];

  return (
    <ModalShell ariaLabel="사전필터" width="w-[480px]" onClose={onClose}>
      <div className="flex">
        <nav className="w-[160px] py-2 border-r border-border" aria-label="필터 그룹">
          <div className="text-fg-dimmer text-xs uppercase tracking-wider px-4 pb-2">필터 그룹</div>
          {NAV.map((n) => (
            <button key={n.id} type="button" aria-current={group === n.id} data-active={n.active}
              onClick={() => setGroup(n.id)}
              className={`flex w-full items-center justify-between px-4 py-2 text-sm ${
                group === n.id ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input'}`}>
              <span>{n.label}</span>
              <NavCheck active={n.active} />
            </button>
          ))}
        </nav>

        <div className="flex-1 px-5 py-4">
          {group === 'market' ? (
            <div className="flex flex-col gap-sm">
              <SectionLabel>시장</SectionLabel>
              <div className="flex gap-px p-[2px] bg-bg-input rounded-md w-fit">
                {MARKETS.map((m) => {
                  const active = markets.includes(m);
                  return (
                    <button key={m} type="button" aria-label={m} aria-pressed={active}
                      onClick={() => toggleMarket(m)}
                      className={`px-2.5 py-[0.15rem] rounded-sm font-mono text-xs transition-colors ${
                        active ? 'bg-accent text-accent-fg' : 'text-fg-dim hover:bg-bg-input-hover'}`}>
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-sm">
              <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
                <input type="checkbox" checked={!!universe.exclude_etf}
                  onChange={(e) => onChange({ ...universe, exclude_etf: e.target.checked || undefined })}
                  className="accent-[var(--accent)]" />ETF 제외</label>
              <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
                <input type="checkbox" checked={!!universe.exclude_halted}
                  onChange={(e) => onChange({ ...universe, exclude_halted: e.target.checked || undefined })}
                  className="accent-[var(--accent)]" />거래정지 제외</label>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end px-4 py-3 border-t border-border">
        <button type="button" onClick={onClose}
          className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">닫기</button>
      </div>
    </ModalShell>
  );
}
