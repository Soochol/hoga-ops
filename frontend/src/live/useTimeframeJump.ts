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
import { realMsToYyyymmdd } from './liveDateTime';
import { savedRangeAnchorTs } from './savedRangeAnchor';
import type { SyncCandle } from '../chart/cursorSync';
import { jumpedLogicalRange, resolveTimeframeJump } from '../chart/timeframeJump';
import type { LiveTimeframe } from '../state/livePage';
import type { VirtualAxis } from '../util/virtualAxis';

/**
 * 이 분봉 창에 걸린 점프의 화면 상태 — 칩이 읽는다.
 *
 * `out-of-retention` 이 따로 있는 이유: 그건 "아직 안 왔다" 가 아니라 **영영 안
 * 온다** 이고, 사용자가 할 수 있는 일도 다르다(기다림 vs 포기). 하나로 뭉치면
 * 칩이 영원히 "불러오는 중" 을 표시한다 — 침묵보다 나쁜 종류의 거짓말이다.
 *
 * `aborted` 도 같은 축에서 갈라져 나왔다. 종전엔 중단을 `landed` 에 뭉쳐서, 칩이 두
 * 경우에 **모두 참인 것**(대상 날짜)밖에 말할 수 없었다 — 창이 움직인 적 없는데
 * "이동했다" 고 하면 거짓이기 때문이다. 중단은 사용자 자신의 행동이라 구별할 수 있는
 * 사실이므로 따로 말하고, 되돌릴 문(`retry`)을 준다.
 */
export type MinuteJumpState = {
  /**
   * 칩이 말할 KST 날짜(YYYYMMDD).
   *
   * `landed` 면 **실제로 앉은 봉의 날짜**이고, 그 전에는 목적지 칸의 상한 날짜다.
   * 둘을 구별하는 이유: 새 계약에서 상한은 **칸의 달력상 끝**이라 비거래일일 수 있다
   * (주봉이면 일요일). 착지한 뒤에도 그 날짜를 계속 말하면 **차트가 보여주지 않는
   * 날을 이름 붙이는 칩**이 되는데, 그것이 #1506 에서 고친 「거짓말하는 칩」과 정확히
   * 같은 모양이다.
   */
  date: string;
  status: 'seeking' | 'landed' | 'aborted' | 'out-of-retention';
  /**
   * `out-of-retention` 일 때 **이 창이 불러올 수 있는 가장 이른 날**(YYYYMMDD).
   *
   * 칩이 상수로 적던 「보유 기간(13개월)」을 대신한다. 그 문구는 이중으로 틀렸다 —
   * 벤더 벽은 250일이고(`earliestAllowedMinuteDate`), 디스크 모드에는 벽 자체가 없다.
   * 값을 상태가 나르면 두 모드에서 모두 맞고, 벽이 바뀌어도 문구가 따라온다.
   */
  floorDate?: string;
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
  /**
   * 칩의 ↻ — 같은 목적지로 **다시** 보낸다(중단 뒤 되돌릴 문).
   *
   * 원래 발행(`origin`)을 그대로 재사용하므로 게이트 판정이 갈리지 않는다. 새 seq 가
   * 매겨져 래치가 풀리는데, 그것이 안전한 것은 seq 가 단조 증가하기 때문이다 —
   * #1508 이전에는 슬롯이 비워지면 되감겨 재발행이 옛 래치에 걸려 죽었다.
   */
  retry: () => void;
};

export function useTimeframeJump(params: {
  chart: IChartApi | null;
  axis: VirtualAxis;
  /** 이 창의 차트 컨테이너 — 사용자 제스처(중단 신호)를 여기서 듣는다. */
  containerRef: { current: HTMLElement | null };
  /** 이 창이 그리고 있는 캔들. **ts 오름차순**이어야 한다(스냅이 이진 탐색). */
  candles: readonly SyncCandle[];
  /**
   * 이 창의 좌측 팬 하한(`useLiveBundle.minuteScrollbackFloorDate`). `null` = 무한.
   *
   * **판정이 여기 있는 이유**: 하한은 모드에 따라 갈린다(벤더=250일 벽, 디스크=캡처가
   * 있는 만큼). 그 값을 아는 것은 **이 분봉 창뿐**이고, 발행하는 일봉 창은 항상
   * `null` 을 본다 — 그래서 「갈 수 없다」는 발행 측이 아니라 소비 측이 말한다.
   */
  minuteScrollbackFloorDate: string | null;
  /** 기능 토글 + 이 봉이 점프를 받는가. 꺼져 있으면 구독도 하지 않는다. */
  enabled: boolean;
  myWindowId: string | null;
  myTimeframe: LiveTimeframe;
  myGroup: number | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
}): TimeframeJumpResult {
  const {
    chart, axis, containerRef, candles, enabled, minuteScrollbackFloorDate,
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
  /** 실제로 앉은 봉의 날짜. **중단이면 null** — 그 경우 앉은 봉이 없다. */
  const [settledDate, setSettledDate] = useState<string | null>(null);
  const settle = useCallback((seq: number, landedDate: string | null = null) => {
    settledSeqRef.current = seq;
    setSettledSeq(seq);
    setSettledDate(landedDate);
  }, []);

  // 상한 날짜 — 칩(착지 전)과 보유 한계 판정이 읽는다. 백필은 **칸 시작**을 쓴다(아래).
  const targetDate = live === null ? null : realMsToYyyymmdd(live.toMs);
  const backfillDate = live === null ? null : realMsToYyyymmdd(live.fromMs);
  // 이 창의 하한 밖이면 백필해도 빈 응답만 온다 — 착지도 시도하지 않는다.
  // 하한이 `null`(디스크 모드·미측정)이면 **막지 않는다**: 모르는 것을 못 간다고
  // 말하지 않는다(그쪽은 캡처가 있는 만큼 더 과거를 볼 수 있다).
  const outOfRetention = targetDate !== null
    && minuteScrollbackFloorDate !== null
    && targetDate < minuteScrollbackFloorDate;

  // ── 착지 ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chart || live === null || outOfRetention) return;
    if (settledSeqRef.current === live.seq) return;
    if (candles.length === 0) return;
    // 그 **칸의 마지막 봉** — 상한 이하에서 뒤로 훑는다.
    //
    // ⚠ **칸 밖으로는 내려가지 않는다.** `savedRangeAnchorTs` 는 상한 이하의 마지막
    // 봉을 주므로 칸이 아직 비어 있으면 **그 앞 칸의 봉**을 돌려준다. 그대로 앉으면
    // 백필 도중에 엉뚱한 구간으로 조기 착지하고 래치까지 걸려 되돌릴 수도 없다.
    // 종전 `snapToLastOfKstDay` 도 그 날 봉이 없으면 물러났다 — 같은 성질이다.
    const anchorTs = savedRangeAnchorTs(candles, live.toMs);
    // 아직 그 칸이 안 왔다 — 래치를 걸지 **않고** 물러난다. 백필이 캔들을 채우면
    // 이 이펙트가 다시 돌아 그때 앉는다.
    if (anchorTs === null || anchorTs < live.fromMs) return;
    const raf = requestAnimationFrame(() => {
      // 예약과 실행 사이에 사용자가 만졌을 수 있다.
      if (settledSeqRef.current === live.seq) return;
      const ts = chart.timeScale();
      // 실행 시점에 다시 읽는다 — 폭은 그 사이 바뀔 수 있고, 낡은 값으로 앉히면
      // 그게 곧 튐이다(`useRangeSyncFollow` 와 같은 처방).
      const current = ts.getVisibleLogicalRange();
      if (!current) return;
      const anchorIndex = ts.timeToIndex?.(
        realMsToVirtualSeconds(axisRef.current, anchorTs) as Time,
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
      settle(live.seq, realMsToYyyymmdd(anchorTs));
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

  const retry = useCallback(() => {
    if (live === null) return;
    useLiveCursorStore.getState().requestTimeframeJump(live.fromMs, live.toMs, live.origin);
  }, [live]);

  const clear = useCallback(() => {
    if (live === null) return;
    setDismissedSeq(live.seq);
    // 라이브 엣지로 복귀 — 저장뷰 칩의 × 와 같은 계약("데려다주되 가두지 않는다" 의
    // 반대편: 풀면 원래 자리로).
    chart?.timeScale().scrollToRealTime();
  }, [chart, live]);

  const state = useMemo<MinuteJumpState | null>(() => {
    if (live === null || targetDate === null) return null;
    if (outOfRetention) {
      return {
        date: targetDate,
        status: 'out-of-retention',
        ...(minuteScrollbackFloorDate === null ? {} : { floorDate: minuteScrollbackFloorDate }),
      };
    }
    if (settledSeq !== live.seq) return { date: targetDate, status: 'seeking' };
    // 앉은 봉이 없으면 중단이다 — 착지 경로만 날짜를 남긴다(`settle` 의 두 번째 인자).
    if (settledDate === null) return { date: targetDate, status: 'aborted' };
    // 착지했으면 **앉은 봉의 날짜**를 말한다.
    return { date: settledDate, status: 'landed' };
  }, [live, targetDate, outOfRetention, settledSeq, settledDate, minuteScrollbackFloorDate]);

  return {
    state,
    // 보유 한계 밖은 백필 대상이 아니다 — 긁어도 빈 응답만 온다.
    //
    // ⚠ **상한이 아니라 칸 시작이다.** 상한을 물리면 로드 구간이 `[칸 끝, 지금]` 이
    // 되어 착지 대상인 그 칸의 봉이 영영 안 온다(`JumpPublication.fromMs` 주석).
    backfillFromDate: live !== null && !outOfRetention ? backfillDate : null,
    clear,
    retry,
  };
}
