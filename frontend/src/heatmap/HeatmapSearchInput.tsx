import type { Ref } from 'react';

/** 검색 돋보기 아이콘 (SVG 통일). */
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

/** 히트맵 목록 필터 검색창(controlled) — /heatmap 페이지와 우측 레일 드로어가 공유.
 *  query 는 호출측 로컬 상태(저장 설정 아님 — 필터는 일시적 조회 보조). Escape 로 클리어(전파 차단).
 *  testId/className 으로 소비처(가로 헤더 vs 세로 스택)마다 폭·식별자를 달리한다. */
export function HeatmapSearchInput({ query, onQuery, testId, className, inputRef }: {
  query: string; onQuery: (v: string) => void; testId?: string; className?: string;
  /** "/" 단축키로 포커스를 걸기 위한 ref(페이지 헤더가 넘긴다). 드로어는 생략. */
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <div className={`relative flex items-center ${className ?? ''}`.trim()}>
      <span className="pointer-events-none absolute left-2 text-fg-dimmer"><SearchIcon /></span>
      <input
        ref={inputRef}
        type="text" value={query} onChange={(e) => onQuery(e.target.value)}
        aria-label="종목·그룹 검색" placeholder="종목·그룹 검색"
        data-testid={testId}
        onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); onQuery(''); } }}
        className="w-full rounded bg-bg-input pl-7 pr-7 py-1 text-xs text-fg border border-border placeholder:text-fg-dimmer focus:outline-none focus:border-border-strong"
      />
      {query && (
        <button type="button" aria-label="검색 지우기" onClick={() => onQuery('')}
          className="absolute right-1.5 grid h-4 w-4 place-items-center rounded text-fg-dimmer hover:text-fg">
          ✕
        </button>
      )}
    </div>
  );
}
