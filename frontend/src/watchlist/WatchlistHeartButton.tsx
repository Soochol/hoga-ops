import { useState } from 'react';
import { HeartIcon } from '../ui/HeartIcon';
import { useWatchlistMembership } from './useWatchlistMembership';
import { WatchlistGroupPicker } from './WatchlistGroupPicker';

/**
 * 공용 관심종목 하트 (v3, ADR-0069). 채움 = code가 ≥1 그룹에 소속. 클릭하면 그룹 선택
 * 팝업(WatchlistGroupPicker)을 자기 위치에 연다 — "미분류" 단일 추가 대상이 없어진 v3에선
 * 모든 하트가 "어디에 넣을지"를 고른다. 5곳(스크리너 페이지·패널·라이브 상태바·라이브 검색·
 * 편집모달)이 이 컴포넌트를 공유한다.
 *
 * variant:
 *  - 'default' : 상시 노출(검색 드롭다운 등). dim → hover 시 또렷.
 *  - 'row'     : 행 안에서 group-hover/focus로 등장(미등록은 초저대비).
 *  - 'status'  : 라이브 상태바 — 항상 또렷(채움/빈은 색·fill로 구분).
 */
export function WatchlistHeartButton({ code, name, variant = 'default' }: {
  code: string;
  name?: string;
  variant?: 'default' | 'row' | 'status';
}) {
  const { isMember } = useWatchlistMembership();
  const member = isMember(code);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);

  const tone = member
    ? 'text-fg'
    : variant === 'row'
      ? 'text-fg-dimmer opacity-45 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-fg focus-visible:text-fg'
      : 'text-fg-dimmer hover:text-fg';

  return (
    <>
      <button
        type="button"
        aria-label="관심 그룹 편집"
        aria-pressed={member}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setPicker({ x: r.left, y: r.bottom + 4 });
        }}
        className={`leading-none transition-[opacity,color] duration-[80ms] ${tone}`}
      >
        <HeartIcon filled={member} className="w-[1em] h-[1em]" />
      </button>
      {picker && (
        <WatchlistGroupPicker code={code} name={name} x={picker.x} y={picker.y}
          onClose={() => setPicker(null)} />
      )}
    </>
  );
}
