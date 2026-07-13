/**
 * 접기 chevron — 펼침=▼(아래, 클릭하면 접기), 접힘=▶(오른쪽). 폴더 관용구
 * (VS Code·TradingView), 좌측 배치와 세트. 접힘은 아래 화살표를 -90° 회전(경로 교체
 * 대신)해 150ms 회전 모션을 얻는다. 유니코드 대신 SVG(폰트별 렌더 불일치 회피).
 * 관심종목 드로어 그룹 헤더와 상세 패널 카드 헤더가 공유한다.
 */
export function ChevronIcon({ collapsed, size = 12 }: { collapsed: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`.trim()}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * 이중 chevron — 상세 패널 전체 접기(»)·펼치기(«)와 접힌 레일에 쓴다.
 * direction='right' = 패널을 밀어 접기, 'left' = 레일에서 다시 펼치기.
 */
export function DoubleChevronIcon({
  direction,
  size = 14,
}: {
  direction: 'left' | 'right';
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {direction === 'right' ? (
        <>
          <path d="M7 6l6 6-6 6" />
          <path d="M13 6l6 6-6 6" />
        </>
      ) : (
        <>
          <path d="M17 6l-6 6 6 6" />
          <path d="M11 6l-6 6 6 6" />
        </>
      )}
    </svg>
  );
}
