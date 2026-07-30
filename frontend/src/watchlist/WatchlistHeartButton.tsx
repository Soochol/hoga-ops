import { useState } from 'react';
import { HeartIcon } from '../ui/HeartIcon';
import { WatchlistGroupPicker } from './WatchlistGroupPicker';

/**
 * 공용 관심종목 하트 (v3, ADR-0070). 채움 = code가 ≥1 그룹에 소속. 클릭하면 그룹 선택
 * 팝업(WatchlistGroupPicker)을 자기 위치에 연다 — "미분류" 단일 추가 대상이 없어진 v3에선
 * 모든 하트가 "어디에 넣을지"를 고른다. 현재 소비처는 스크리너 결과표와 라이브 심볼 검색
 * 두 곳이고, **둘 다 리스트**다.
 *
 * `isMember` 를 **prop 으로 받는다**(2026-07-30). 이전에는 이 컴포넌트가
 * `useWatchlistMembership()` 을 직접 불렀는데, 그 훅의 계약은 "Call ONCE per component
 * (not per row)" 이고 소비처가 둘 다 리스트라 **행마다** 호출되고 있었다 — 1,000행이면
 * react-query 옵저버 1,000개다. 실측(jsdom, React 커밋 소요, 재렌더): 500행 44 → 30 ms,
 * 1,000행 65 → 59 ms. 1,000행 개선폭이 작은 것은 그 규모에선 행 자체의 렌더·DOM 비용이
 * 지배적이기 때문이고, 그건 가상화의 몫이지 이 변경의 몫이 아니다.
 * prop 을 필수로 둬 타입이 계약을 강제한다.
 *
 * variant:
 *  - 'default' : 상시 노출(검색 드롭다운 등). dim → hover 시 또렷.
 *  - 'row'     : 행 안에서 group-hover/focus로 등장(미등록은 초저대비).
 *  - 'status'  : 라이브 상태바 — 항상 또렷(채움/빈은 색·fill로 구분).
 */
export function WatchlistHeartButton({ code, name, isMember, variant = 'default' }: {
  code: string;
  /** ≥1 그룹 소속 여부. 리스트 소유자가 `useWatchlistMembership()` 을 한 번 불러 내린다. */
  isMember: boolean;
  name?: string;
  variant?: 'default' | 'row' | 'status';
}) {
  const member = isMember;
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
        onPointerDown={(e) => e.stopPropagation()}
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
