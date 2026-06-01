import { useState } from 'react';
import type { ScreenerUniverse } from '../api/screener';
import { countActiveUniverse, universeSummary } from './universeFilter';
import { UniverseFilterModal } from './UniverseFilterModal';

// 깔때기 글리프 — 이모지 금지(LiveToolbar 보조지표 버튼과 같은 인라인 SVG 관습).
function FunnelIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h18l-7 8v6l-4 2v-8z" />
    </svg>
  );
}

// 빌더 헤더의 전역 사전필터 트리거. 활성 개수 배지 + accent 테두리 + 열거형
// aria-label(닫힌 모달 상태 가시성). 클릭 시 UniverseFilterModal 렌더.
export function UniverseFilterButton({ universe, onChange }: {
  universe: ScreenerUniverse;
  onChange: (u: ScreenerUniverse) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = countActiveUniverse(universe);
  const label = count > 0 ? `사전필터, ${count}개: ${universeSummary(universe)}` : '사전필터';

  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-expanded={open}
        aria-label={label} title={label} onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-bg-input border hover:bg-bg-input-hover ${
          count > 0 ? 'border-accent text-fg' : 'border-border-strong text-fg-dim'}`}>
        <FunnelIcon />
        <span>사전필터</span>
        {count > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.05rem] h-[1.05rem] px-1 rounded-full bg-accent text-accent-fg text-badge font-bold leading-none">
            {count}
          </span>
        )}
      </button>
      {open && <UniverseFilterModal universe={universe} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}
