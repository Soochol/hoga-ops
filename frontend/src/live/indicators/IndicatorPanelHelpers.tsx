


export type CategoryId =
  | 'supertrend'
  | 'bollinger'
  | 'envelope'
  | 'moving-average'
  | 'daily-moving-average'
  | 'volume'
  | 'trade-value'
  | 'foreign-net'
  | 'institution-net'
  | 'peak-walls'
  | 'trade-volume-poc'
  | 'depth-heatmap'
  | 'volume-distribution'
  | 'quote-totals'
  | 'ratio'
  | 'fill-strength'
  | 'broker-late-entry'
  | 'program-daily'
  | 'program-trade';


export type GroupId = 'top' | 'hoga' | 'program' | 'broker';


/** 차트의 어디에 그려지는가. 글리프가 암시하는 것을 헤더가 텍스트로 확정한다. */
export type Placement = 'overlay' | 'pane';


// 드리프트 테스트(`IndicatorPanel.paneNames.test.ts`)가 pane 을 가진 항목의 라벨을
// `PANE_DISPLAY_NAME` 과 대조하므로 export 한다 — 같은 pane 을 설정 패널과 차트
// 레전드가 다르게 부르면 안 된다.
//
// `description` 은 각 Config 컴포넌트가 자기 `h3`+`p` 로 들고 있던 문장을 그대로
// 올린 것이다. 한 지표의 이름과 설명을 패널 헤더와 Config 가 각자 적고 있으면
// 언젠가 갈린다 — 미리보기 카드(아직 추가하지 않은 지표)는 Config 를 렌더하지
// 않으므로 설명이 Config 안에 있으면 **애초에 닿지도 못한다**.
export const CATEGORIES: ReadonlyArray<{
  id: CategoryId;
  label: string;
  group: GroupId;
  description: string;
  placement: Placement;
}> = [
  { id: 'moving-average',  label: '이동평균선',       group: 'top',  placement: 'overlay',
    description: '설정한 봉 수의 평균 가격을 선으로 표시합니다.' },
  { id: 'supertrend', label: '슈퍼트렌드', group: 'top', placement: 'overlay',
    description: 'ATR 변동성을 바탕으로 상승·하락 추세를 표시합니다.' },
  { id: 'bollinger', label: '볼린저 밴드', group: 'top', placement: 'overlay',
    description: '이동평균선 위아래에 가격 변동폭을 표시합니다.' },
  { id: 'envelope', label: '엔벨로프', group: 'top', placement: 'overlay',
    description: '단순이동평균선 위아래에 설정한 비율의 가격 밴드를 표시합니다.' },
  { id: 'daily-moving-average', label: '일봉 이동평균선',  group: 'top',  placement: 'overlay',
    description: '일봉 종가의 이동평균선을 분봉 차트에 표시합니다. 분봉 전용입니다.' },
  { id: 'volume',          label: '거래량',           group: 'top',  placement: 'pane',
    description: '봉별 거래량을 막대로 표시합니다.' },
  { id: 'trade-value',     label: '거래대금',         group: 'top', placement: 'pane',
    description: '일·주·월별 거래대금을 막대로 표시합니다.' },
  { id: 'quote-totals',    label: '총잔량',           group: 'hoga', placement: 'pane',
    description: '분봉 시점의 매수·매도 총잔량을 선으로 표시합니다.' },
  { id: 'ratio',           label: '호가비',           group: 'hoga', placement: 'pane',
    description: '매수·매도 잔량의 우위를 0선 위아래로 표시합니다.' },
  { id: 'fill-strength',   label: '체결강도',         group: 'hoga', placement: 'pane',
    description: '분봉별 매수·매도 체결량을 막대로 표시합니다.' },
  { id: 'volume-distribution', label: '연속체결 매물대 분포', group: 'hoga', placement: 'overlay',
    description: '거래일별 가격대에 쌓인 연속체결량을 표시합니다. 동시호가는 제외합니다.' },
  { id: 'trade-volume-poc', label: '당일 최대 매물대', group: 'hoga', placement: 'overlay',
    description: '연속체결량이 가장 많은 가격대를 밴드로 표시합니다. 동시호가는 제외합니다.' },
  { id: 'peak-walls',      label: '당일 최대벽',     group: 'hoga', placement: 'overlay',
    description: '거래일별 10호가의 최대 매수·매도벽을 표시합니다. 분봉 전용입니다.' },
  { id: 'depth-heatmap',   label: '호가 잔량 히트맵', group: 'hoga', placement: 'overlay',
    description: '10호가 잔량을 색상 강도로 표시합니다. 보이는 구간의 최대 잔량 기준이며, 분봉 전용입니다.' },
  { id: 'foreign-net',     label: '외국인 순매수량',  group: 'broker',  placement: 'pane',
    description: '외국인의 일별 순매수·총매수·총매도 수량을 표시합니다.' },
  { id: 'institution-net', label: '기관 순매수량',    group: 'broker',  placement: 'pane',
    description: '기관의 일별 순매수·총매수·총매도 수량을 표시합니다.' },
  { id: 'broker-late-entry', label: '신규 거래원 등장', group: 'broker', placement: 'overlay',
    description: '기준 시각 이후 처음 등장한 거래원을 표시합니다. 세트별로 시각을 나눌 수 있습니다.' },
  { id: 'program-daily', label: '프로그램 순매수량', group: 'program', placement: 'pane',
    description: '프로그램의 일별 순매수·총매수·총매도 수량을 표시합니다. 종목 일봉 전용입니다.' },
  { id: 'program-trade',   label: '프로그램 순매수',  group: 'program', placement: 'pane',
    description: '시간별 프로그램 누적 순매수 금액을 표시합니다.' },
];
