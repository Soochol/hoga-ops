/**
 * 기간 점프의 **소비 배선** — 판정과 수식은 `chart/timeframeJump.ts` 가 갖고, 여기서는
 * 그것을 lightweight-charts 와 DOM 이벤트에 붙인다.
 *
 * 발행 쪽에는 훅이 없다. 점프는 제스처를 추적하는 것이 아니라 **버튼 한 번**이라
 * 스토어 액션(`requestTimeframeJump`)을 직접 부르면 끝이다 — 기간 동기화가 발행
 * 훅을 갖는 이유(제스처 구간 만들기)가 여기엔 없다.
 *
 * ── 착지는 **재시도**가 필요하고, 그래서 래치가 필요하다 ──────────────────
 * 두 달 전으로 점프하면 그 날 봉은 아직 로드돼 있지 않다. 백필이 채워 줄 때까지
 * 기다렸다가 앉아야 하므로 착지는 `candles` 가 바뀔 때마다 재시도한다.
 *
 * 그 재시도를 **끄지 않으면 창이 사용자 손에서 벗어난다.** 분봉 번들은 SSE 틱마다
 * 갱신되므로(실측 초당 ~8회) 착지한 뒤에도 이펙트가 계속 돌고, 사용자가 팬으로
 * 빠져나가려 할 때마다 도로 끌려온다. 그래서 `seq` 하나는 **한 번만 착지한다**
 * (`settledSeqRef`), 그리고 착지 전이라도 사용자가 그 창을 만지면 그 seq 를
 * **포기한다**. 두 경로가 같은 래치를 쓰므로 상태 전이는 seq 당 단방향이다.
 *
 * 같은 날짜로 다시 누르면 `seq` 가 올라가 새 명령이 되고 래치가 자연히 풀린다 —
 * 스토어가 값 동일 no-op 을 하지 않는 이유가 그것이다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import { useLiveCursorStore } from './useLiveCursorStore';
import { realMsToVirtualSeconds } from './viewportAnchor';
import { minuteRightOffsetBars } from './minuteViewportPolicy';
import { earliestAllowedMinuteDate, realMsToYyyymmdd, todayKstYyyymmdd } from './liveDateTime';
import { snapToLastOfKstDay, type SyncCandle } from '../chart/cursorSync';
import { jumpedLogicalRange, resolveTimeframeJump } from '../chart/timeframeJump';
import type { LiveTimeframe } from '../state/livePage';
import type { VirtualAxis } from '../util/virtualAxis';

/**
 * 이 분봉 창에 걸린 점프의 화면 상태 — 칩이 읽는다.
 *
 * `out-of-retention` 이 따로 있는 이유: 그건 "아직 안 왔다" 가 아니라 **영영 안
 * 온다** 이고, 사용자가 할 수 있는 일도 다르다(기다림 vs 포기). 하나로 뭉치면
 * 칩이 영원히 "불러오는 중" 을 표시한다 — 침묵보다 나쁜 종류의 거짓말이다.
 */
export type MinuteJumpState = {
  /** 목적지 KST 날짜(YYYYMMDD). */
  date: string;
  status: 'seeking' | 'landed' | 'out-of-retention';
};

export type TimeframeJumpResult = {
  /** 칩에 그릴 상태. 걸린 점프가 없으면 null. */
  state: MinuteJumpState | null;
  /**
   * 이 창이 백필로 채워야 할 시작일(YYYYMMDD). **게이트를 통과한 명령만** 나온다 —
   * 원시 슬롯을 백필에 그대로 물리면 창번호·종목이 달라 **받지도 않은** 점프를 위해
   * 과거를 긁는 창이 생긴다.
   */
  backfillFromDate: string | null;
  /** 칩의 × — 이 창만 점프에서 풀고 라이브 엣지로 돌아간다. */
  clear: () => void;
};

export function useTimeframeJump(params: {
  chart: IChartApi | null;
  axis: VirtualAxis;
  /** 이 창의 차트 컨테이너 — 사용자 제스처(중단 신호)를 여기서 듣는다. */
  containerRef: { current: HTMLElement | null };
  /** 이 창이 그리고 있는 캔들. **ts 오름차순**이어야 한다(스냅이 이진 탐색). */
  candles: readonly SyncCandle[];
  /** 기능 토글 + 이 봉이 점프를 받는가. 꺼져 있으면 구독도 하지 않는다. */
  enabled: boolean;
  myWindowId: string | null;
  myTimeframe: LiveTimeframe;
  myGroup: number | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
}): TimeframeJumpResult {
  const {
    chart, axis, containerRef, candles, enabled,
    myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol,
  } = params;
  const jumpRequest = useLiveCursorStore((s) => s.jumpRequest);
  const axisRef = useRef(axis);
  axisRef.current = axis;

  // 이 창이 추종을 시작한 시점의 명령 번호. 이보다 큰 것만 본다 — 슬롯에 남아 있던
  // 옛 명령을 새로 연 창이 적용하면 그 창의 초기 뷰 배치와 싸운다(기간 동기화의
  // baseline 과 같은 규율).
  const baselineSeqRef = useRef<number | null>(null);
  if (baselineSeqRef.current === null) {
    baselineSeqRef.current = useLiveCursorStore.getState().jumpRequest?.seq ?? 0;
  }

  // 사용자가 × 로 푼 명령. 슬롯을 지우지 않는 이유: 슬롯은 그룹 공용이라 지우면
  // **다른 분봉 창의 칩까지** 사라진다. 해제는 창의 로컬 사실이다.
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null);

  const live = useMemo(() => {
    if (!enabled) return null;
    const resolved = resolveTimeframeJump({
      publication: jumpRequest, myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol,
    });
    if (!resolved) return null;
    if (resolved.seq <= (baselineSeqRef.current ?? 0)) return null;
    if (resolved.seq === dismissedSeq) return null;
    return resolved;
  }, [
    enabled, jumpRequest, myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol, dismissedSeq,
  ]);

  // 이 seq 는 끝났다 — 착지했거나 사용자가 그 창을 만져 포기했거나.
  //
  // ref 와 state 를 **함께** 든다. ref 는 rAF 안에서의 즉시 판정용(중단은 포인터
  // 이벤트로 오므로 다음 렌더를 기다릴 수 없다), state 는 칩이 「불러오는 중」을
  // 끄기 위한 렌더 트리거용이다. 둘이 갈리지 않도록 쓰는 자리를 이 함수 하나로 묶는다.
  const settledSeqRef = useRef<number | null>(null);
  const [settledSeq, setSettledSeq] = useState<number | null>(null);
  const settle = useCallback((seq: number) => {
    settledSeqRef.current = seq;
    setSettledSeq(seq);
  }, []);

  const targetDate = live === null ? null : realMsToYyyymmdd(live.toMs);
  // 분봉 보유 한계 밖이면 백필해도 벤더가 못 준다 — 착지도 시도하지 않는다.
  const outOfRetention = targetDate !== null
    && targetDate < earliestAllowedMinuteDate(todayKstYyyymmdd());

  // ── 착지 ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chart || live === null || outOfRetention) return;
    if (settledSeqRef.current === live.seq) return;
    if (candles.length === 0) return;
    // 그 날 **마지막 봉**. 스냅은 일봉→분봉 크로스헤어와 같은 함수를 쓴다 — 두
    // 기능이 다른 봉에 서면 같은 조작이 두 답을 낸다.
    const target = snapToLastOfKstDay(candles, live.toMs);
    // 아직 그 날이 안 왔다 — 래치를 걸지 **않고** 물러난다. 백필이 캔들을 채우면
    // 이 이펙트가 다시 돌아 그때 앉는다.
    if (target === null) return;
    const raf = requestAnimationFrame(() => {
      // 예약과 실행 사이에 사용자가 만졌을 수 있다.
      if (settledSeqRef.current === live.seq) return;
      const ts = chart.timeScale();
      // 실행 시점에 다시 읽는다 — 폭은 그 사이 바뀔 수 있고, 낡은 값으로 앉히면
      // 그게 곧 튐이다(`useRangeSyncFollow` 와 같은 처방).
      const current = ts.getVisibleLogicalRange();
      if (!current) return;
      const anchorIndex = ts.timeToIndex?.(
        realMsToVirtualSeconds(axisRef.current, target.ts_ms) as Time,
        true,
      );
      if (typeof anchorIndex !== 'number' || !Number.isFinite(anchorIndex)) return;
      const next = jumpedLogicalRange({
        anchorIndex,
        current,
        // 원시 `rightOffset` 이 아니다 — 분봉 창은 가격 라벨 거터를 봉 수로 환산해
        // 따로 비운다. 그걸 무시하면 착지한 봉이 라벨 밑에 깔린다.
        rightOffsetBars: minuteRightOffsetBars(current.to - current.from, ts.width()),
      });
      // ⚠ **`next` 가 null 이어도 래치를 건다.** null 은 "이미 그 자리" 라는 뜻이고,
      // 그때 래치를 빼먹으면 틱마다 이 이펙트가 다시 돌아 사용자가 팬으로 빠져나갈
      // 수 없다 — 바로 이 훅이 막으려는 그 증상이다.
      settle(live.seq);
      if (next) ts.setVisibleLogicalRange(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [chart, live, outOfRetention, candles, settle]);

  // ── 중단 — 사용자가 그 창을 만지면 그 명령은 끝난 것으로 본다 ────────────
  //
  // 착지 **전**에도 유효하다: 백필을 기다리는 동안 사용자가 다른 구간으로 팬했는데
  // 뒤늦게 캔들이 도착해 끌어가면, 사용자 입장에서는 아무 조작 없이 화면이 튄다.
  useEffect(() => {
    const target = containerRef.current;
    if (!target || live === null) return;
    if (settledSeqRef.current === live.seq) return;
    const abort = () => settle(live.seq);
    // capture — lwc 의 핸들러(캔버스=타겟)보다 먼저 듣는다. 기간 동기화 발행이
    // 같은 이유로 같은 단계를 쓴다.
    target.addEventListener('pointerdown', abort, { capture: true });
    target.addEventListener('wheel', abort, { passive: true, capture: true });
    return () => {
      target.removeEventListener('pointerdown', abort, { capture: true });
      target.removeEventListener('wheel', abort, { capture: true });
    };
  }, [containerRef, live, settle]);

  const clear = useCallback(() => {
    if (live === null) return;
    setDismissedSeq(live.seq);
    // 라이브 엣지로 복귀 — 저장뷰 칩의 × 와 같은 계약("데려다주되 가두지 않는다" 의
    // 반대편: 풀면 원래 자리로).
    chart?.timeScale().scrollToRealTime();
  }, [chart, live]);

  const state = useMemo<MinuteJumpState | null>(() => {
    if (live === null || targetDate === null) return null;
    if (outOfRetention) return { date: targetDate, status: 'out-of-retention' };
    return { date: targetDate, status: settledSeq === live.seq ? 'landed' : 'seeking' };
  }, [live, targetDate, outOfRetention, settledSeq]);

  return {
    state,
    // 보유 한계 밖은 백필 대상이 아니다 — 긁어도 빈 응답만 온다.
    backfillFromDate: live !== null && !outOfRetention ? targetDate : null,
    clear,
  };
}
