


export type CategoryId =
  | 'supertrend'
  | 'bollinger'
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
    description: '지난 n일 동안 주가 평균값을 이은 선' },
  { id: 'supertrend', label: '슈퍼트렌드', group: 'top', placement: 'overlay',
    description: 'ATR 변동성을 기준으로 추세선을 표시합니다. 상승·하락 추세는 종가와 밴드의 돌파로 전환됩니다.' },
  { id: 'bollinger', label: '볼린저 밴드', group: 'top', placement: 'overlay',
    description: '이동평균선을 중심으로 표준편차 배수만큼 떨어진 상단·하단 밴드를 표시합니다.' },
  { id: 'daily-moving-average', label: '일봉 이동평균선',  group: 'top',  placement: 'overlay',
    description: '일봉 종가 기준 이평선을 분봉 차트에 투영 · 분봉 차트에서만 표시됩니다' },
  { id: 'volume',          label: '거래량',           group: 'top',  placement: 'pane',
    description: '해당 봉 동안 체결된 거래량을 막대로 표시합니다.' },
  { id: 'trade-value',     label: '거래대금',         group: 'top', placement: 'pane',
    description: '해당 일·주·월 동안의 거래대금을 막대로 표시합니다.' },
  { id: 'quote-totals',    label: '총잔량',           group: 'hoga', placement: 'pane',
    description: '해당 분봉 시점의 매수·매도 호가 총잔량을 라인으로 표시합니다.' },
  { id: 'ratio',           label: '호가비',           group: 'hoga', placement: 'pane',
    description: '매수·매도 호가 총잔량의 불균형(우위)을 0 기준선 위아래로 표시합니다.' },
  { id: 'fill-strength',   label: '체결강도',         group: 'hoga', placement: 'pane',
    description: '해당 분봉 동안 체결된 매수·매도 물량을 막대로 표시합니다.' },
  { id: 'volume-distribution', label: '연속체결 매물대 분포', group: 'hoga', placement: 'overlay',
    description: '정규장 연속매매 체결만 집계한 가격대별 체결량 분포를 거래일 단위로 표시합니다. 가격 구간은 각 Stock-Date 캔들 저가-고가 범위를 기준으로 나눕니다.' },
  { id: 'trade-volume-poc', label: '당일 최대 매물대', group: 'hoga', placement: 'overlay',
    description: '정규장 연속매매 체결량을 연속체결 매물대 분포와 동일한 가격 구간에 누적하고, 거래량이 가장 큰 구간을 캔들 위 밴드로 표시합니다. 동시호가 제외.' },
  { id: 'peak-walls',      label: '당일 최대벽',     group: 'hoga', placement: 'overlay',
    description: '차트에 보이는 거래일마다, 그 날 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격을 표시합니다. 계열 셋(체결된 벽·미도달 벽·전체 최대벽)을 각각 수평선·화살표·라벨·레전드로 그리고, 강도 계단을 별도 pane 에 낼 수 있습니다. 매도·매수를 각각 설정합니다. 분봉 차트에서만 표시됩니다' },
  { id: 'depth-heatmap',   label: '호가 잔량 히트맵', group: 'hoga', placement: 'overlay',
    description: '각 분봉 시점의 10호가 매수·매도 잔량을 캔들 뒤 색상 강도로 표시합니다. 강도는 화면에 보이는 범위의 최대 잔량 기준으로 정규화됩니다. 분봉 차트에서만 표시됩니다' },
  { id: 'foreign-net',     label: '외국인 순매수량',  group: 'broker',  placement: 'pane',
    description: '일자별 외국인의 순매수·총매수·총매도 수량을 선택해 막대로 표시합니다.' },
  { id: 'institution-net', label: '기관 순매수량',    group: 'broker',  placement: 'pane',
    description: '일자별 기관의 순매수·총매수·총매도 수량을 선택해 막대로 표시합니다.' },
  { id: 'broker-late-entry', label: '신규 거래원 등장', group: 'broker', placement: 'overlay',
    description: '기준 시각 이후에 처음 등장한 거래원을 마커로 표시합니다. 시각대를 나눠 보려면 세트를 추가하세요.' },
  { id: 'program-daily', label: '프로그램 순매수량', group: 'program', placement: 'pane',
    description: '일자별 프로그램 순매수·총매수·총매도 수량을 선택해 막대로 표시합니다. 종목 일봉 전용입니다.' },
  { id: 'program-trade',   label: '프로그램 순매수',  group: 'program', placement: 'pane',
    description: '시간별 프로그램 누적 순매수 금액을 표시합니다.' },
];
