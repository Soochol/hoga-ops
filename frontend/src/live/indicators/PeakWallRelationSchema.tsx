/**
 * 세 계열이 **당일 고가(매수는 저가)를 기준으로 어떻게 갈리는지**를 한 그림으로.
 *
 * 설명 세 줄("체결이 그 가격을 쳤다" / "아직 안 닿았다 — 위와 배타" / "터치 무관
 * 상위집합")은 읽으면 맞는 말이지만, 셋의 **관계**가 문장 사이에 흩어져 있어
 * 매번 재구성해야 한다. 배타와 포함을 한 번에 보여 주는 것이 그림의 일이다.
 *
 * **선**은 선택된 방향의 실제 계열 색을 받는다 — 스와치에서 색을 바꾸면 이 그림도
 * 따라 움직여야 "저 파란 선이 이 항목" 이 유지된다. 고정 색을 박으면 사용자가 색을
 * 바꾸는 순간 그림이 거짓말을 시작한다.
 *
 * **글자는 그 색을 따르지 않는다.** 사용자 색은 임의라 밝은 값(기본 전체 최대벽이
 * `#93C5FD`)이 밝은 테마에서 읽히지 않는다. 선의 색과 위치가 이미 연결을 만들고
 * 있으므로 글자는 `--fg-dim` 으로 둔다 — 대비 규칙 안에 있고, 색이 무엇이든 읽힌다.
 */
export default function PeakWallRelationSchema({
  side,
  tradedColor,
  unreachedColor,
  allWallColor,
}: {
  side: 'ask' | 'bid';
  tradedColor: string;
  unreachedColor: string;
  allWallColor: string;
}) {
  const isAsk = side === 'ask';
  // 매도는 고가 **위**가 미도달, 매수는 저가 **아래**가 미도달 — 그림을 뒤집는다.
  const extremeLabel = isAsk ? '당일 고가' : '당일 저가';
  const unreachedY = isAsk ? 14 : 80;
  const tradedY = isAsk ? 48 : 46;
  const extremeY = isAsk ? 30 : 64;

  return (
    <div className="rounded-lg bg-bg-subtle px-3.5 py-3">
      <svg
        viewBox="0 0 460 96"
        className="w-full"
        role="img"
        aria-label={`체결된 벽·미도달 벽·전체 최대벽이 ${extremeLabel}를 기준으로 갈리는 관계`}
      >
        <g opacity="0.28" fill="currentColor" className="text-fg-dim">
          <rect x="53" y="34" width="14" height="30" rx="1" />
          <rect x="123" y="24" width="14" height="30" rx="1" />
          <rect x="193" y="36" width="14" height="32" rx="1" />
          <rect x="263" y="42" width="14" height="30" rx="1" />
        </g>
        {/* 기준선 — 이 선을 넘었는지가 체결/미도달을 가른다. */}
        <line
          x1="8" y1={extremeY} x2="330" y2={extremeY}
          stroke="currentColor" strokeWidth="1" strokeDasharray="4 3"
          className="text-fg-dim"
        />
        <text x="336" y={extremeY + 3} fontSize="9" fill="currentColor" className="fill-fg-dim">
          {extremeLabel}
        </text>

        <line x1="240" y1={unreachedY} x2="392" y2={unreachedY} stroke={unreachedColor} strokeWidth="2.5" strokeLinecap="round" />
        <text x="398" y={unreachedY + 3} fontSize="9" className="fill-fg-dim">미도달</text>

        <line x1="30" y1={tradedY} x2="182" y2={tradedY} stroke={tradedColor} strokeWidth="2.5" strokeLinecap="round" />
        <text x="188" y={tradedY + 3} fontSize="9" className="fill-fg-dim">체결됨</text>

        {/* 전체 최대벽은 앞 둘과 그 사이까지 포함하는 상위집합이라 가장 넓게 걸친다. */}
        <line x1="110" y1="86" x2="330" y2="86" stroke={allWallColor} strokeWidth="2.5" strokeLinecap="round" />
        <text x="336" y="89" fontSize="9" className="fill-fg-dim">전체 최대</text>
      </svg>
    </div>
  );
}
