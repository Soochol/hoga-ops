import { HeartIcon } from '../ui/HeartIcon';

/**
 * 공용 관심종목 추가/해제 토글 하트. HeartIcon + 접근성(aria-label 추가/해제,
 * aria-pressed) + 이벤트 격리(onMouseDown preventDefault, onClick stopPropagation)
 * + 중립 색 규율(DESIGN.md: 하트는 second accent 아님 — 미등록 dim, 등록 fg)을
 * 한 곳에 캡슐화한다. 호출처는 isMember/onToggle 만 안다(코드 바인딩은 호출처가).
 *
 * variant:
 *  - 'default' : 상시 노출(검색 드롭다운 등). dim → hover 시 또렷.
 *  - 'row'     : QuoteRow 안에서 group-hover/focus 로 등장(미등록은 초저대비).
 *
 * 주의: LiveStatusBar 의 하트는 "항상 채워진 + 색으로 등록 표시"라는 별도 의도
 * 설계(테스트됨)라 이 버튼을 쓰지 않는다.
 */
export function WatchlistToggleButton({
  isMember,
  onToggle,
  variant = 'default',
}: {
  isMember: boolean;
  onToggle: () => void;
  variant?: 'default' | 'row';
}) {
  const tone = isMember
    ? 'text-fg'
    : variant === 'row'
      ? 'text-fg-dimmer opacity-45 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-fg focus-visible:text-fg'
      : 'text-fg-dimmer hover:text-fg';
  return (
    <button
      type="button"
      aria-label={isMember ? '관심종목 해제' : '관심종목 추가'}
      aria-pressed={isMember}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={`leading-none transition-[opacity,color] duration-[80ms] ${tone}`}
    >
      <HeartIcon filled={isMember} className="w-[1em] h-[1em]" />
    </button>
  );
}
