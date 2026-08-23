import { useRef, useState } from 'react';
import type { ScreenerScope, ScreenerUniverse } from '../api/screener';
import { ModalShell } from '../ui/ModalShell';
import { CheckIcon } from '../ui/CheckIcon';
import { SectionLabel } from './paramForms';

const MARKETS = ['KOSPI', 'KOSDAQ'] as const;
const SCOPES: { id: ScreenerScope; label: string }[] = [
  { id: 'watchlist', label: '관심종목' },
  { id: 'heatmap', label: '히트맵 종목' },
];
type Group = 'market' | 'exclude' | 'scope';

// 전역 사전필터 편집 모달. 좌측 nav 2그룹(시장/제외) + 우측 pane 전환.
// 토글은 즉시 onChange 호출(초안 버퍼 없음); 확인/Esc/배경은 순수 dismiss.
// 취소는 열 때 스냅샷으로 되돌린다 — 실수한 토글을 저장본 재로드 없이 복구하는 유일한 길.
export function UniverseFilterModal({ universe, onChange, onClose }: {
  universe: ScreenerUniverse;
  onChange: (u: ScreenerUniverse) => void;
  onClose: () => void;
}) {
  const [group, setGroup] = useState<Group>('market');
  // 열린 시점의 스냅샷(마운트 1회). 이후 prop 은 토글마다 갱신되므로 ref 로 고정한다.
  const openedWithRef = useRef(universe);
  const cancel = () => {
    // 무변경 취소가 dirty 플래그를 건드리지 않도록, 실제로 달라졌을 때만 되돌린다.
    if (JSON.stringify(universe) !== JSON.stringify(openedWithRef.current)) {
      onChange(openedWithRef.current);
    }
    onClose();
  };
  const markets = universe.markets ?? [];
  const scopes = universe.scopes ?? [];
  const toggleMarket = (m: (typeof MARKETS)[number]) => {
    const next = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    onChange({ ...universe, markets: next.length ? next : undefined });
  };
  const toggleScope = (s: ScreenerScope) => {
    const next = scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s];
    onChange({ ...universe, scopes: next.length ? next : undefined });
  };
  const NAV: { id: Group; label: string; active: boolean }[] = [
    { id: 'market', label: '시장', active: !!universe.markets?.length },
    { id: 'exclude', label: '제외', active: !!(universe.exclude_etf || universe.exclude_halted) },
    { id: 'scope', label: '종목 범위', active: !!universe.scopes?.length },
  ];

  return (
    <ModalShell ariaLabel="사전필터" title="사전필터" width="w-[480px]" onClose={onClose}>
      <div className="flex">
        <nav className="w-[160px] py-2 border-r border-border" aria-label="필터 그룹">
          <div className="text-fg-dim text-xs uppercase px-4 pb-2">필터 그룹</div>
          {NAV.map((n) => (
            <button key={n.id} type="button" aria-current={group === n.id} data-active={n.active}
              onClick={() => setGroup(n.id)}
              className={`flex w-full items-center justify-between px-4 py-2 text-sm ${
                group === n.id ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input'}`}>
              <span>{n.label}</span>
              <CheckIcon filled={n.active} size={16} />
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
                      className={`px-2.5 py-[0.15rem] rounded-sm font-data text-xs transition-colors ${
                        active ? 'bg-accent text-accent-fg' : 'text-fg-dim hover:bg-bg-input-hover'}`}>
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : group === 'exclude' ? (
            <div className="flex flex-col gap-sm">
              <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
                {/* ⚠ **언체크를 `undefined` 로 접지 않는다** — 다른 토글과 다른 유일한 자리다.
                    백엔드 기본이 `true`(제외)로 바뀌어서(2026-08-23), 키를 빼면 「끈 것」이
                    「기본값=제외」로 읽혀 정확히 반대로 동작한다. 여기서 `false` 는
                    **사용자가 명시적으로 포함시켰다**는 뜻이고 그대로 실려야 한다. */}
                <input type="checkbox" checked={universe.exclude_etf ?? true}
                  onChange={(e) => onChange({ ...universe, exclude_etf: e.target.checked })}
                  className="accent-[var(--accent)]" />ETF 제외</label>
              <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
                <input type="checkbox" checked={!!universe.exclude_halted}
                  onChange={(e) => onChange({ ...universe, exclude_halted: e.target.checked || undefined })}
                  className="accent-[var(--accent)]" />거래정지 제외</label>
            </div>
          ) : (
            <div className="flex flex-col gap-sm">
              <SectionLabel>종목 범위</SectionLabel>
              <p className="text-xs text-fg-dim">
                선택 시 해당 집합의 합집합에서만 조회합니다 — 미선택 시 전체 시장.
                실시간 모니터링 리소스를 크게 줄입니다
              </p>
              {SCOPES.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
                  <input type="checkbox" checked={scopes.includes(s.id)}
                    onChange={() => toggleScope(s.id)}
                    className="accent-[var(--accent)]" />{s.label}</label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
        <button type="button" onClick={cancel}
          className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">취소</button>
        <button type="button" onClick={onClose}
          className="px-3 py-1.5 text-sm rounded font-semibold"
          style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}>확인</button>
      </div>
    </ModalShell>
  );
}
