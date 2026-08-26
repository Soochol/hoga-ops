/**
 * 지표 글리프의 SSOT — 15종, 16px, 단색.
 *
 * ## 글리프가 두 가지를 동시에 말한다
 *
 * 이름만으로는 그 지표가 선인지 마커인지, 캔들 위에 겹치는지 차트 아래 pane 을
 * 새로 먹는지 알 수 없다. 그래서 그림 문법을 둘로 갈랐다:
 *
 * - **오버레이 지표** — 흐린 캔들 고스트 **위**에 그 지표의 마크를 얹는다.
 * - **하단 패널 지표** — 구분선 **아래** 스트립에 마크를 그린다.
 *
 * 즉 글리프 하나가 "무엇을 그리나" 와 "어디에 그리나" 를 함께 답한다. 후자는
 * 헤더 eyebrow 가 텍스트로 확정하고(`PLACEMENT_LABEL`), 글리프는 그걸 목록에서
 * 미리 보여 주는 역할이다.
 *
 * ## 색을 쓰지 않는다
 *
 * 전부 `currentColor` 단색이다. 색은 이 앱에서 세 갈래로 엄격히 나뉘어 있고
 * (UI 상태 / 시스템 상태 / 시세 방향), 글리프가 그중 어느 쪽을 집어도 그 축이
 * 흐려진다. 행에서 색을 지는 것은 **인스턴스 색 점**이고 그건 데이터다.
 *
 * ## `<use href>` 를 쓰지 않는다 (의도)
 *
 * 캔들 고스트와 pane 프레임은 여러 글리프가 공유하지만, `<symbol id>` + `<use>`
 * 로 묶으면 **문서 전역 id** 가 필요하다. 이 맵은 nav 15행과 미리보기 카드에서
 * 동시에 렌더되므로 그 순간 id 가 중복되고, 중복 id 의 `<use>` 는 조용히 첫
 * 정의만 따라간다. 조각을 JSX 상수로 두면 그런 전역이 아예 없다.
 */
import type { ReactNode } from 'react';
import type { CategoryId } from './IndicatorPanel';

const svg = (children: ReactNode) => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
    {children}
  </svg>
);

/** 오버레이 글리프의 바탕 — 지표 마크가 이 위에 얹힌다. */
const GHOST_CANDLES = (
  <g opacity="0.2">
    <line x1="4.5" y1="2.5" x2="4.5" y2="12.5" stroke="currentColor" strokeWidth="1" />
    <rect x="3" y="5" width="3" height="4.5" rx="0.5" fill="currentColor" />
    <line x1="10.5" y1="1.5" x2="10.5" y2="11" stroke="currentColor" strokeWidth="1" />
    <rect x="9" y="3.5" width="3" height="5" rx="0.5" fill="currentColor" />
  </g>
);

/** 하단 패널 글리프의 바탕 — 축소된 캔들과 pane 경계선. 마크는 선 아래에 온다. */
const PANE_FRAME = (
  <>
    <g opacity="0.16">
      <rect x="3.5" y="2.5" width="2.5" height="4" rx="0.5" fill="currentColor" />
      <rect x="9.5" y="1.5" width="2.5" height="4.5" rx="0.5" fill="currentColor" />
    </g>
    <line x1="1" y1="8.75" x2="15" y2="8.75" stroke="currentColor" strokeWidth="1" opacity="0.3" />
  </>
);

/** 부호 있는 막대 pane(투자자·프로그램)의 0 기준선. */
const ZERO_LINE = (
  <line x1="1" y1="12.25" x2="15" y2="12.25" stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
);

/**
 * `Record<CategoryId, …>` 라 카테고리를 추가하면 **컴파일이 막힌다** — 글리프 없는
 * 지표가 조용히 빈칸으로 렌더되지 않는다.
 */
export const INDICATOR_GLYPH: Record<CategoryId, ReactNode> = {
  'moving-average': svg(
    <>
      {GHOST_CANDLES}
      <path
        d="M1.5 11.5 C4 10.5 5 6.5 8 6.5 C11 6.5 12 4.5 14.5 3.5"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
      />
    </>,
  ),
  // 일봉 MA 는 분봉 차트에 **투영**된 선이라 파선으로 갈라 둔다.
  'daily-moving-average': svg(
    <>
      {GHOST_CANDLES}
      <path
        d="M1.5 12 C4.5 11.5 6 8 9 7 C11.5 6.2 13 5 14.5 4.5"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="2.6 2"
      />
    </>,
  ),
  volume: svg(
    <>
      {PANE_FRAME}
      <rect x="2" y="12.5" width="2.4" height="2.5" fill="currentColor" />
      <rect x="5.2" y="11" width="2.4" height="4" fill="currentColor" />
      <rect x="8.4" y="12" width="2.4" height="3" fill="currentColor" />
      <rect x="11.6" y="10.5" width="2.4" height="4.5" fill="currentColor" />
    </>,
  ),
  // 총잔량은 매수·매도 두 줄이라 선이 둘이다.
  'quote-totals': svg(
    <>
      {PANE_FRAME}
      <path d="M1.5 11.5 L6 12.5 L10 11 L14.5 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M1.5 14 L6 13 L10 14.2 L14.5 13.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.5" />
    </>,
  ),
  // 호가비는 0 기준선 위아래를 오간다.
  ratio: svg(
    <>
      {PANE_FRAME}
      <line x1="1.5" y1="12.75" x2="14.5" y2="12.75" stroke="currentColor" strokeWidth="0.8" opacity="0.35" strokeDasharray="1.5 1.5" />
      <path d="M1.5 13.5 L5 11 L8.5 14 L11.5 11.5 L14.5 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>,
  ),
  'fill-strength': svg(
    <>
      {PANE_FRAME}
      <path d="M1.5 14 C4 14 5 10.8 8 11.5 C11 12.2 12.5 11 14.5 11.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>,
  ),
  // 매물대 분포 — 가격대별 가로 막대가 캔들 위에 겹친다.
  'volume-distribution': svg(
    <>
      {GHOST_CANDLES}
      <rect x="8" y="3" width="6.5" height="2" fill="currentColor" opacity="0.45" />
      <rect x="10" y="6.2" width="4.5" height="2" fill="currentColor" />
      <rect x="6.5" y="9.4" width="8" height="2" fill="currentColor" opacity="0.7" />
      <rect x="11" y="12.6" width="3.5" height="2" fill="currentColor" opacity="0.45" />
    </>,
  ),
  // 그중 최대 구간 하나만 굵은 밴드로.
  'trade-volume-poc': svg(
    <>
      {GHOST_CANDLES}
      <line x1="1" y1="7.5" x2="15" y2="7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>,
  ),
  // 최대벽 — 매도·매수 두 방향의 수평선이 각자 그날 구간만큼.
  'peak-walls': svg(
    <>
      {GHOST_CANDLES}
      <line x1="6" y1="4" x2="15" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="1" y1="11.5" x2="10" y2="11.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
    </>,
  ),
  // 히트맵은 캔들을 가리는 격자라 고스트 없이 격자만.
  'depth-heatmap': svg(
    <>
      <rect x="2" y="2" width="5.5" height="2.6" rx="0.5" fill="currentColor" opacity="0.25" />
      <rect x="8.5" y="2" width="5.5" height="2.6" rx="0.5" fill="currentColor" opacity="0.55" />
      <rect x="2" y="5.4" width="5.5" height="2.6" rx="0.5" fill="currentColor" opacity="0.85" />
      <rect x="8.5" y="5.4" width="5.5" height="2.6" rx="0.5" fill="currentColor" opacity="0.35" />
      <rect x="2" y="8.8" width="5.5" height="2.6" rx="0.5" fill="currentColor" opacity="0.45" />
      <rect x="8.5" y="8.8" width="5.5" height="2.6" rx="0.5" fill="currentColor" opacity="0.7" />
      <rect x="2" y="12.2" width="5.5" height="2.6" rx="0.5" fill="currentColor" opacity="0.2" />
      <rect x="8.5" y="12.2" width="5.5" height="2.6" rx="0.5" fill="currentColor" opacity="0.4" />
    </>,
  ),
  // 투자자 순매수는 0 기준선 양쪽으로 뻗는 막대. 외국인은 매수 우위 모양,
  // 기관은 매도 우위 모양으로 서로 다른 실루엣을 준다(둘이 이웃해 있다).
  'foreign-net': svg(
    <>
      {PANE_FRAME}
      {ZERO_LINE}
      <rect x="2" y="10" width="2.4" height="2.25" fill="currentColor" />
      <rect x="5.2" y="12.25" width="2.4" height="2.2" fill="currentColor" opacity="0.5" />
      <rect x="8.4" y="9.4" width="2.4" height="2.85" fill="currentColor" />
      <rect x="11.6" y="10.6" width="2.4" height="1.65" fill="currentColor" />
    </>,
  ),
  'institution-net': svg(
    <>
      {PANE_FRAME}
      {ZERO_LINE}
      <rect x="2" y="12.25" width="2.4" height="2.4" fill="currentColor" opacity="0.5" />
      <rect x="5.2" y="10.3" width="2.4" height="1.95" fill="currentColor" />
      <rect x="8.4" y="12.25" width="2.4" height="1.6" fill="currentColor" opacity="0.5" />
      <rect x="11.6" y="9.6" width="2.4" height="2.65" fill="currentColor" />
    </>,
  ),
  // 신규 거래원은 "그 시점에 처음 나타났다" 라 깃발이다.
  'broker-late-entry': svg(
    <>
      {GHOST_CANDLES}
      <line x1="13" y1="3" x2="13" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13 3 L7.5 5 L13 7 Z" fill="currentColor" />
    </>,
  ),
  'program-trade': svg(
    <>
      {PANE_FRAME}
      <line x1="1" y1="12.5" x2="15" y2="12.5" stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <path d="M1.5 13.8 L4.5 11 L8 13.5 L11 10.5 L14.5 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>,
  ),
};
