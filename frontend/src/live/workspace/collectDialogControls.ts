/**
 * 데이터 수집 다이얼로그 명령 채널.
 *
 * `indicatorDrawerControls` 와 같은 모듈 레지스트리 idiom — 다이얼로그 본체는
 * 모달이라 페이지당 1개이고 열림 상태는 셸(`LivePage`)이 소유하는데, 트리거는
 * 캔버스 안 차트 창 헤더에 있다.
 *
 * **드로어와 달리 windowId 가 아니라 종목을 싣는다.** 수집이 하는 일은 그 종목의
 * 지난 N일 데이터를 백엔드가 긁어오는 것이라 결과가 창에 귀속되지 않는다 —
 * 같은 종목을 띄운 창이 둘이면 어느 쪽에서 눌러도 결과가 같다. 창은 "어느
 * 종목이냐" 를 결정할 뿐이고(창→그룹→종목), 그 결정이 끝나면 창은 무관해진다.
 * 트리거를 창에 두는 이유도 그것 — 전역에 두면 "활성 그룹" 을 먼저 맞춰야 했다.
 */
/** 차트에 지금 보이는 캔들 구간(양 끝 캔들의 KST 거래일, YYYYMMDD).
 *  수집 버튼 클릭 시점에 그 창의 뷰포트에서 스냅샷으로 얼려 싣는다 — 다이얼로그가
 *  열린 동안 팬해도 표시가 흔들리지 않게. 뷰포트를 못 읽으면(콜드/지수 창) null. */
export type CollectVisibleRange = { startYmd: string; endYmd: string };

export type CollectTarget = {
  code: string;
  name: string;
  visibleRange?: CollectVisibleRange | null;
};

let opener: ((target: CollectTarget) => void) | null = null;

export function registerCollectDialogOpener(open: (target: CollectTarget) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** 차트 창 헤더의 수집 버튼 → 셸에 "이 종목을 수집 대상으로 열어라". */
export function requestCollectDialog(target: CollectTarget): void {
  opener?.(target);
}
